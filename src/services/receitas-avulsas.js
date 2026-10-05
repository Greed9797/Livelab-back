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
  perdido_em, perdido_motivo, perdido_por`

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
    observacao: row.observacao ?? null,
    aporte: row.grupo === 'aporte',
    virtual: false,
    perdido_em: timestampIso(row.perdido_em),
    perdido_motivo: row.perdido_motivo ?? null,
    perdido_por: row.perdido_por ?? null,
  }
  item.status = statusLancamento(item, hoje)
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
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING ${RECEITA_AVULSA_COLS}`,
    params,
  )
  return rows[0] ? receitaAvulsaParaItem(rows[0], hoje) : null
}

export async function excluirReceitaAvulsa(db, { tenantId, id }) {
  if (!RE_UUID.test(String(id ?? ''))) return false
  const r = await db.query('DELETE FROM receitas_avulsas WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id', [id, tenantId])
  return (r.rowCount ?? r.rows.length) > 0
}

const erroPerdida = () => erro(
  'Receita dada como perdida. Desfaça a perda/cancelamento antes de receber.', 409, 'RECEITA_PERDIDA',
)

/** Baixa: valor_pago default = valor_previsto; data_pagamento default = hoje. Perdida → 409. */
export async function receberReceitaAvulsa(db, { tenantId, id, valorPago, dataPagamento, hoje = hojeSaoPaulo() }) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  if (valorPago != null && !(r2(valorPago) > 0)) throw erro('valor_pago deve ser maior que zero')
  validarPagamento(valorPago, dataPagamento)
  const { rows } = await db.query(
    `UPDATE receitas_avulsas
        SET valor_pago = COALESCE($3::numeric, valor_previsto),
            data_pagamento = COALESCE($4::date, $5::date),
            atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND perdido_em IS NULL
      RETURNING ${RECEITA_AVULSA_COLS}`,
    [id, tenantId, valorPago == null ? null : r2(valorPago), dataPagamento ?? null, hoje],
  )
  if (rows[0]) return receitaAvulsaParaItem(rows[0], hoje)
  // Nada atualizado: não existe no tenant (null → 404) ou está perdida (409).
  if (await buscarReceitaAvulsa(db, { tenantId, id, hoje })) throw erroPerdida()
  return null
}

/**
 * Dá a receita avulsa como perdida (cliente não vai pagar): encerra o saldo
 * previsto − pago; valor_pago é preservado. 100% recebida → 409. Idempotente:
 * já perdida mantém perdido_em/perdido_por; `motivo` informado substitui o anterior.
 * Retorna { item, ja_perdido } ou null se não existir no tenant.
 */
export async function perderReceitaAvulsa(db, { tenantId, id, motivo, actorUserId = null, hoje = hojeSaoPaulo() }) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  const motivoNorm = normalizarMotivo(motivo)
  const atual = await buscarReceitaAvulsa(db, { tenantId, id, hoje })
  if (!atual) return null
  if (atual.valor_pago > 0 && atual.valor_pago >= atual.valor_previsto) {
    throw erro('Receita já recebida integralmente não pode ser dada como perdida', 409, 'RECEITA_PAGA')
  }
  if (!atual.perdido_em && (typeof motivo !== 'string' || !motivoNorm)) {
    throw erro('motivo é obrigatório para dar a receita como perdida', 400, 'INVALID_MOTIVO')
  }
  const { rows } = await db.query(
    `UPDATE receitas_avulsas
        SET perdido_em = COALESCE(perdido_em, NOW()),
            perdido_por = CASE WHEN perdido_em IS NULL THEN $3::uuid ELSE perdido_por END,
            perdido_motivo = CASE WHEN perdido_em IS NULL THEN $4::text ELSE COALESCE($4::text, perdido_motivo) END,
            atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
        AND NOT (valor_pago > 0 AND valor_pago >= valor_previsto)
      RETURNING ${RECEITA_AVULSA_COLS}`,
    [id, tenantId, actorUserId ?? null, motivoNorm],
  )
  if (!rows[0]) throw erro('Receita já recebida integralmente não pode ser dada como perdida', 409, 'RECEITA_PAGA')
  return { item: receitaAvulsaParaItem(rows[0], hoje), ja_perdido: Boolean(atual.perdido_em) }
}

/** Desfaz a perda (perdido_* → NULL). Idempotente. Retorna { item, estava_perdido } ou null. */
export async function desperderReceitaAvulsa(db, { tenantId, id, hoje = hojeSaoPaulo() }) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  const atual = await buscarReceitaAvulsa(db, { tenantId, id, hoje })
  if (!atual) return null
  if (!atual.perdido_em) return { item: atual, estava_perdido: false }
  const { rows } = await db.query(
    `UPDATE receitas_avulsas
        SET perdido_em = NULL, perdido_motivo = NULL, perdido_por = NULL, atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING ${RECEITA_AVULSA_COLS}`,
    [id, tenantId],
  )
  return rows[0] ? { item: receitaAvulsaParaItem(rows[0], hoje), estava_perdido: true } : null
}

export async function desfazerReceitaAvulsa(db, { tenantId, id, hoje = hojeSaoPaulo() }) {
  if (!RE_UUID.test(String(id ?? ''))) return null
  const { rows } = await db.query(
    `UPDATE receitas_avulsas SET valor_pago = 0, data_pagamento = NULL, atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING ${RECEITA_AVULSA_COLS}`,
    [id, tenantId],
  )
  return rows[0] ? receitaAvulsaParaItem(rows[0], hoje) : null
}
