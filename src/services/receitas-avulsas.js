// Receitas avulsas (não vinculadas a marcas): aporte | servico | reembolso | outros.
//
// Modelo (migration 170): grava só valor_previsto, valor_pago, data_vencimento,
// data_pagamento e competencia (dia 1) — e, desde a 173, perdido_em/motivo/por
// (receita dada como perdida). Status é SEMPRE derivado
// (lib/lancamento-status.js). Datas trafegam como 'YYYY-MM-DD' (sem Date).
// Toda query leva tenant_id explícito (além do RLS).
//
// Grupo 'aporte' é entrada de caixa separada: fica fora da receita operacional do
// DRE e da base do imposto (ver financeiro-agregador.js).

import { normalizarMotivo, statusLancamento, timestampIso } from '../lib/lancamento-status.js'
import { centsToExactMoney, exactMoneyToCents } from '../lib/money.js'
import { perdaJaRegistrada, requisicaoPerda } from '../lib/perda-idempotencia.js'

export const GRUPOS_RECEITA_AVULSA = Object.freeze(['aporte', 'servico', 'reembolso', 'outros'])

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const primeiroDia = (d) => `${String(d).slice(0, 7)}-01`

function erro(message, statusCode = 400, code = 'INVALID_RECEITA_AVULSA') {
  const e = new Error(message)
  e.statusCode = statusCode
  e.code = code
  return e
}

export function hojeSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now)
}

export const ehAporte = (item) => item?.origem === 'avulsa' && item?.grupo === 'aporte'

export const RECEITA_AVULSA_COLS = `id, descricao, grupo, valor_previsto, valor_pago, observacao,
  to_char(data_vencimento,'YYYY-MM-DD') AS data_vencimento,
  to_char(data_pagamento,'YYYY-MM-DD') AS data_pagamento,
  to_char(competencia,'YYYY-MM-DD') AS competencia,
  perdido_em, perdido_motivo, perdido_por, valor_perdido`

/** Linha de receitas_avulsas → item do contrato comum (natureza 'receita', origem 'avulsa'). */
export function receitaAvulsaParaItem(row, hoje = hojeSaoPaulo()) {
  const item = {
    id: row.id,
    natureza: 'receita',
    origem: 'avulsa',
    grupo: row.grupo,
    descricao: row.descricao,
    competencia: row.competencia,
    data_vencimento: row.data_vencimento,
    data_pagamento: row.data_pagamento ?? null,
    valor_previsto: r2(row.valor_previsto),
    valor_pago: r2(row.valor_pago),
    valor_perdido: row.valor_perdido == null
      ? (row.perdido_em ? r2(centsToExactMoney(saldoCents(row))) : 0)
      : r2(row.valor_perdido),
    observacao: row.observacao ?? null,
    aporte: row.grupo === 'aporte',
    virtual: false,
    perdido_em: timestampIso(row.perdido_em),
    perdido_motivo: row.perdido_motivo ?? null,
    perdido_por: row.perdido_por ?? null,
  }
  item.status = statusLancamento(item, hoje)
  if (row.valor_perdido != null && !row.perdido_em && item.valor_perdido > 0 && item.valor_pago > 0 &&
      exactMoneyToCents(row.valor_pago) + exactMoneyToCents(row.valor_perdido) >= exactMoneyToCents(row.valor_previsto)) {
    item.status = 'perdido'
  }
  return item
}

/** Receitas avulsas cuja COMPETÊNCIA está em [inicio, fim] (YYYY-MM ou YYYY-MM-DD). */
export async function listarReceitasAvulsas(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), grupo, status } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  const mi = String(inicio ?? '').slice(0, 7)
  const mf = String(fim ?? inicio ?? '').slice(0, 7)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mi) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mf) || mf < mi) {
    throw erro('Período inválido (use AAAA-MM)', 400, 'INVALID_PERIOD')
  }
  const { rows } = await db.query(
    `SELECT ${RECEITA_AVULSA_COLS}
       FROM receitas_avulsas
      WHERE tenant_id = $1::uuid
        AND competencia >= $2::date AND competencia <= $3::date
      ORDER BY data_vencimento, criado_em`,
    [tenantId, `${mi}-01`, `${mf}-01`],
  )
  return rows
    .map((r) => receitaAvulsaParaItem(r, hoje))
    .filter((i) => (!grupo || i.grupo === grupo) && (!status || i.status === status))
}

export async function buscarReceitaAvulsa(db, { tenantId, id, hoje = hojeSaoPaulo() }) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  const { rows } = await db.query(
    `SELECT ${RECEITA_AVULSA_COLS} FROM receitas_avulsas WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  )
  return rows[0] ? receitaAvulsaParaItem(rows[0], hoje) : null
}

function validarPagamento(valorPago, dataPagamento) {
  const pago = r2(valorPago ?? 0)
  if (pago < 0) throw erro('valor_pago não pode ser negativo')
  if (dataPagamento != null && !RE_DATA.test(String(dataPagamento))) throw erro('data_pagamento deve estar no formato AAAA-MM-DD')
  return pago
}

/**
 * Cria uma receita avulsa. competencia default = mês do vencimento (sempre dia 1).
 * Com valor_pago > 0, data_pagamento default = hoje.
 */
export async function criarReceitaAvulsa(db, { tenantId, dados, hoje = hojeSaoPaulo(), actorUserId = null }) {
  const d = dados ?? {}
  if (!GRUPOS_RECEITA_AVULSA.includes(d.grupo ?? 'outros')) throw erro('grupo inválido')
  if (!(r2(d.valor_previsto) > 0)) throw erro('valor_previsto deve ser maior que zero')
  if (!RE_DATA.test(String(d.data_vencimento ?? ''))) throw erro('data_vencimento deve estar no formato AAAA-MM-DD')
  const pago = validarPagamento(d.valor_pago, d.data_pagamento)
  const dataPagamento = pago > 0 ? (d.data_pagamento ?? hoje) : null
  const { rows } = await db.query(
    `INSERT INTO receitas_avulsas (tenant_id, descricao, grupo, valor_previsto, valor_pago, data_vencimento,
                                   data_pagamento, competencia, observacao, criado_por)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date, $8::date, $9, $10::uuid)
     RETURNING ${RECEITA_AVULSA_COLS}`,
    [tenantId, d.descricao, d.grupo ?? 'outros', r2(d.valor_previsto), pago, d.data_vencimento,
      dataPagamento, primeiroDia(d.competencia ?? d.data_vencimento), d.observacao ?? null, actorUserId],
  )
  return receitaAvulsaParaItem(rows[0], hoje)
}

const CAMPOS_EDITAVEIS = ['descricao', 'grupo', 'valor_previsto', 'data_vencimento', 'competencia', 'observacao']

/** Edita campos de cadastro (não a baixa — use receber/desfazer). null se não existir no tenant. */
export async function editarReceitaAvulsa(db, { tenantId, id, dados, hoje = hojeSaoPaulo() }) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  const d = dados ?? {}
  if (d.grupo != null && !GRUPOS_RECEITA_AVULSA.includes(d.grupo)) throw erro('grupo inválido')
  if (d.valor_previsto != null && !(r2(d.valor_previsto) > 0)) throw erro('valor_previsto deve ser maior que zero')
  if (d.data_vencimento != null && !RE_DATA.test(String(d.data_vencimento))) throw erro('data_vencimento deve estar no formato AAAA-MM-DD')
  const sets = []
  const params = [id, tenantId]
  for (const campo of CAMPOS_EDITAVEIS) {
    if (!(campo in d)) continue
    let v = d[campo]
    if (campo === 'competencia') v = v == null ? null : primeiroDia(v)
    if (campo === 'valor_previsto') v = r2(v)
    if ((campo === 'competencia' || campo === 'descricao' || campo === 'grupo' || campo === 'data_vencimento') && v == null) {
      throw erro(`${campo} não pode ser nulo`)
    }
    params.push(v)
    const cast = campo === 'competencia' || campo === 'data_vencimento' ? '::date' : ''
    sets.push(`${campo} = $${params.length}${cast}`)
  }
  if (sets.length === 0) throw erro('Nada para atualizar')
  const { rows } = await db.query(
    `UPDATE receitas_avulsas SET ${sets.join(', ')}, atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND valor_perdido IS NULL
      RETURNING ${RECEITA_AVULSA_COLS}`,
    params,
  )
  return rows[0] ? receitaAvulsaParaItem(rows[0], hoje) : null
}

export async function excluirReceitaAvulsa(db, { tenantId, id }) {
  if (!RE_UUID.test(String(id ?? ''))) return false
  const r = await db.query('DELETE FROM receitas_avulsas WHERE id = $1::uuid AND tenant_id = $2::uuid AND valor_perdido IS NULL RETURNING id', [id, tenantId])
  return (r.rowCount ?? r.rows.length) > 0
}

const erroPerdida = () => erro(
  'Receita dada como perdida. Desfaça a perda/cancelamento antes de receber.', 409, 'RECEITA_PERDIDA',
)

/** Baixa: valor_pago default = saldo recebível após perdas. */
export async function receberReceitaAvulsa(db, { tenantId, id, valorPago, dataPagamento, hoje = hojeSaoPaulo() }) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  if (valorPago != null && !(r2(valorPago) > 0)) throw erro('valor_pago deve ser maior que zero')
  validarPagamento(valorPago, dataPagamento)
  // A conciliação Asaas já abre transação. SAVEPOINT mantém sua atomicidade;
  // fora dela, 25P01 indica que este serviço deve abrir a própria transação.
  let savepoint = false
  try {
    await db.query('SAVEPOINT receita_avulsa_receber')
    savepoint = true
  } catch (error) {
    if (error.code !== '25P01') throw error
    await db.query('BEGIN')
  }
  const concluir = () => db.query(savepoint ? 'RELEASE SAVEPOINT receita_avulsa_receber' : 'COMMIT')
  try {
    const { rows: locked } = await db.query(
      'SELECT id, valor_pago, perdido_em FROM receitas_avulsas WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE',
      [id, tenantId],
    )
    if (!locked[0]) { await concluir(); return null }
    if (locked[0].perdido_em) throw erroPerdida()
    const { rows } = await db.query(
      `UPDATE receitas_avulsas
          SET valor_pago = COALESCE($3::numeric, valor_previsto - COALESCE(valor_perdido, 0)),
              data_pagamento = COALESCE($4::date, $5::date),
              atualizado_em = NOW()
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND perdido_em IS NULL
          AND COALESCE($3::numeric, valor_previsto - COALESCE(valor_perdido, 0)) > 0
          AND COALESCE($3::numeric, valor_previsto - COALESCE(valor_perdido, 0))
              <= valor_previsto - COALESCE(valor_perdido, 0)
          AND valor_pago < valor_previsto - COALESCE(valor_perdido, 0)
        RETURNING ${RECEITA_AVULSA_COLS}`,
      [id, tenantId, valorPago == null ? null : r2(valorPago), dataPagamento ?? null, hoje],
    )
    if (!rows[0]) throw erroPerdida()
    await concluir()
    return receitaAvulsaParaItem(rows[0], hoje)
  } catch (error) {
    await db.query(savepoint ? 'ROLLBACK TO SAVEPOINT receita_avulsa_receber' : 'ROLLBACK').catch(() => {})
    throw error
  }
}

function motivoPerdaObrigatorio(motivo) {
  const normalizado = normalizarMotivo(motivo)
  if (!normalizado) throw erro('motivo é obrigatório', 400, 'INVALID_MOTIVO')
  return normalizado
}

function centsReceitaAvulsa(row) {
  return {
    previsto: exactMoneyToCents(row.valor_previsto),
    pago: exactMoneyToCents(row.valor_pago),
  }
}

function saldoCents(row) {
  const { previsto, pago } = centsReceitaAvulsa(row)
  return previsto > pago ? previsto - pago : 0n
}

async function buscarReceitaAvulsaParaUpdate(db, { tenantId, id }) {
  const { rows } = await db.query(
    `SELECT ${RECEITA_AVULSA_COLS}
       FROM receitas_avulsas
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      FOR UPDATE`,
    [id, tenantId],
  )
  return rows[0] ?? null
}

function valorSolicitadoCents(valor, campo) {
  try {
    const cents = exactMoneyToCents(valor)
    if (cents > 0n) return cents
  } catch { /* mensagem uniforme para entrada inválida */ }
  throw erro(`${campo} deve ser texto decimal positivo com até duas casas`, 400, 'INVALID_PERDA_VALUE')
}

function atorEvento(actorType, actorId) {
  const id = String(actorId ?? '').trim()
  if (!id) throw erro('ator da perda é obrigatório', 500, 'INVALID_PERDA_ACTOR')
  return { tipo: String(actorType ?? 'usuario').trim() || 'usuario', id }
}

function perdaAtualCents(row) {
  if (row.valor_perdido != null) return exactMoneyToCents(row.valor_perdido)
  return row.perdido_em ? saldoCents(row) : 0n
}

async function inserirEvento(db, { tenantId, row, tipo, cents, motivo, actorType, actorId, perdaOriginalId = null,
  chaveOperacao = null, requisicao = null }) {
  const ator = atorEvento(actorType, actorId)
  await db.query(
    `INSERT INTO financeiro_perdas_eventos
       (tenant_id, tipo, origem_tipo, origem_id, valor, motivo, ator_tipo, ator_id,
        competencia_obrigacao, perda_original_id, perda_original_tipo, chave_operacao, requisicao)
     VALUES ($1::uuid, $2, 'receita_avulsa', $3::uuid, $4::numeric, $5, $6, $7,
             $8::date, $9::uuid, CASE WHEN $2 = 'reversao' THEN 'perda' ELSE NULL END,
             $10::uuid, $11::jsonb)`,
    [tenantId, tipo, row.id, centsToExactMoney(cents), motivo, ator.tipo, ator.id,
      row.competencia, perdaOriginalId, chaveOperacao, requisicao && JSON.stringify(requisicao)],
  )
}

async function perdasReversiveis(db, { tenantId, row }) {
  const { rows } = await db.query(
    `SELECT p.id, p.valor::text AS valor, COALESCE(SUM(r.valor), 0)::text AS valor_revertido
       FROM financeiro_perdas_eventos p
       LEFT JOIN financeiro_perdas_eventos r ON r.tenant_id = p.tenant_id
        AND r.tipo = 'reversao' AND r.perda_original_id = p.id
      WHERE p.tenant_id = $1::uuid AND p.tipo = 'perda' AND p.origem_tipo = 'receita_avulsa'
        AND p.origem_id = $2::uuid AND p.competencia_obrigacao = $3::date
      GROUP BY p.id, p.valor, p.registrado_em
     HAVING p.valor > COALESCE(SUM(r.valor), 0)
      ORDER BY p.registrado_em, p.id`,
    [tenantId, row.id, row.competencia],
  )
  return rows.map((p) => ({ id: p.id, disponivel: exactMoneyToCents(p.valor) - exactMoneyToCents(p.valor_revertido) }))
}

export async function perderReceitaAvulsa(db, {
  tenantId, id, motivo, valorPerda, chaveOperacao = null, actorUserId = null, actorId = actorUserId,
  actorType = 'usuario', hoje = hojeSaoPaulo(),
}) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  const solicitado = valorPerda == null ? null : valorSolicitadoCents(valorPerda, 'valor_perda')
  const requisicao = requisicaoPerda({ chaveOperacao, tipo: 'perda', origemTipo: 'receita_avulsa', ref: id, motivo, valor: valorPerda })
  await db.query('BEGIN')
  try {
    const atual = await buscarReceitaAvulsaParaUpdate(db, { tenantId, id })
    if (!atual) { await db.query('COMMIT'); return null }
    if (await perdaJaRegistrada(db, { tenantId, chaveOperacao, requisicao })) {
      await db.query('COMMIT')
      return { item: receitaAvulsaParaItem(atual, hoje), ja_perdido: true }
    }
    const { previsto, pago } = centsReceitaAvulsa(atual)
    if (pago >= previsto) throw erro('Receita já recebida integralmente não pode ser dada como perdida', 409, 'RECEITA_PAGA')
    if (atual.perdido_em && atual.valor_perdido == null) {
      throw erro('Perda legada sem evento FIN-02 exige reconciliação', 409, 'RECEITA_PERDA_LEGADA')
    }
    const perdido = perdaAtualCents(atual)
    const disponivel = previsto > pago + perdido ? previsto - pago - perdido : 0n
    if (disponivel === 0n && solicitado == null && perdido > 0n) {
      await db.query('COMMIT')
      return { item: receitaAvulsaParaItem(atual, hoje), ja_perdido: true }
    }
    const motivoNorm = motivoPerdaObrigatorio(motivo)
    const cents = solicitado ?? disponivel
    if (cents <= 0n || cents > disponivel) throw erro('valor_perda excede o saldo disponível', 409, 'PERDA_MAIOR_QUE_SALDO')
    const novaPerda = perdido + cents
    const encerra = novaPerda >= previsto - pago
    const { rows } = await db.query(
      `UPDATE receitas_avulsas
          SET valor_perdido = $3::numeric,
              perdido_em = CASE WHEN $4::boolean THEN COALESCE(perdido_em, NOW()) ELSE NULL END,
              perdido_por = $5::uuid, perdido_motivo = $6::text, atualizado_em = NOW()
        WHERE id = $1::uuid AND tenant_id = $2::uuid
        RETURNING ${RECEITA_AVULSA_COLS}`,
      [id, tenantId, centsToExactMoney(novaPerda), encerra, actorUserId, motivoNorm],
    )
    await inserirEvento(db, { tenantId, row: atual, tipo: 'perda', cents, motivo: motivoNorm, actorType, actorId,
      chaveOperacao, requisicao })
    await db.query('COMMIT')
    return { item: receitaAvulsaParaItem(rows[0], hoje), ja_perdido: perdido > 0n }
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
}

export async function desperderReceitaAvulsa(db, {
  tenantId, id, motivo, valorReversao, chaveOperacao = null, actorUserId = null, actorId = actorUserId,
  actorType = 'usuario', hoje = hojeSaoPaulo(),
}) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  const solicitado = valorReversao == null ? null : valorSolicitadoCents(valorReversao, 'valor_reversao')
  const requisicao = requisicaoPerda({ chaveOperacao, tipo: 'reversao', origemTipo: 'receita_avulsa', ref: id, motivo, valor: valorReversao })
  await db.query('BEGIN')
  try {
    const atual = await buscarReceitaAvulsaParaUpdate(db, { tenantId, id })
    if (!atual) { await db.query('COMMIT'); return null }
    if (await perdaJaRegistrada(db, { tenantId, chaveOperacao, requisicao })) {
      await db.query('COMMIT')
      return { item: receitaAvulsaParaItem(atual, hoje), estava_perdido: true }
    }
    if (atual.perdido_em && atual.valor_perdido == null) {
      throw erro('Perda legada sem evento FIN-02 exige reconciliação', 409, 'RECEITA_PERDA_LEGADA')
    }
    const perdido = perdaAtualCents(atual)
    if (perdido === 0n && solicitado == null) {
      await db.query('COMMIT')
      return { item: receitaAvulsaParaItem(atual, hoje), estava_perdido: false }
    }
    const motivoNorm = motivoPerdaObrigatorio(motivo)
    const cents = solicitado ?? perdido
    if (cents > perdido) throw erro('valor_reversao excede a perda líquida', 409, 'REVERSAO_MAIOR_QUE_PERDA')
    const perdas = await perdasReversiveis(db, { tenantId, row: atual })
    if (perdas.reduce((sum, p) => sum + p.disponivel, 0n) < cents) {
      throw erro('Histórico FIN-02 insuficiente para reversão', 409, 'PERDA_EVENTOS_INCONSISTENTES')
    }
    const novaPerda = perdido - cents
    const { rows } = await db.query(
      `UPDATE receitas_avulsas
          SET valor_perdido = $3::numeric,
              perdido_em = CASE WHEN $3::numeric > 0 AND $3::numeric >= GREATEST(valor_previsto - valor_pago, 0)
                                THEN perdido_em ELSE NULL END,
              perdido_motivo = CASE WHEN $3::numeric = 0 THEN NULL ELSE perdido_motivo END,
              perdido_por = CASE WHEN $3::numeric = 0 THEN NULL ELSE perdido_por END,
              atualizado_em = NOW()
        WHERE id = $1::uuid AND tenant_id = $2::uuid
        RETURNING ${RECEITA_AVULSA_COLS}`,
      [id, tenantId, centsToExactMoney(novaPerda)],
    )
    let restante = cents
    let primeiraParcela = true
    for (const perda of perdas) {
      if (restante === 0n) break
      const parcela = perda.disponivel < restante ? perda.disponivel : restante
      await inserirEvento(db, { tenantId, row: atual, tipo: 'reversao', cents: parcela, motivo: motivoNorm,
        actorType, actorId, perdaOriginalId: perda.id,
        chaveOperacao: primeiraParcela ? chaveOperacao : null,
        requisicao: primeiraParcela ? requisicao : null })
      primeiraParcela = false
      restante -= parcela
    }
    await db.query('COMMIT')
    return { item: receitaAvulsaParaItem(rows[0], hoje), estava_perdido: true }
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
}

export async function desfazerReceitaAvulsa(db, { tenantId, id, hoje = hojeSaoPaulo() }) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  const { rows } = await db.query(
    `UPDATE receitas_avulsas SET valor_pago = 0, data_pagamento = NULL,
        perdido_em = CASE WHEN valor_perdido IS NOT NULL AND valor_perdido < valor_previsto
                          THEN NULL ELSE perdido_em END,
        atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING ${RECEITA_AVULSA_COLS}`,
    [id, tenantId],
  )
  return rows[0] ? receitaAvulsaParaItem(rows[0], hoje) : null
}
