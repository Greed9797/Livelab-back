// Pagamentos de apresentadoras como lançamentos financeiros (natureza 'custo').
// valor_previsto = total do fechamento (buscarFechamentoApresentadoras — NÃO reimplementado);
// baixa persistida em apresentadora_pagamentos; status derivado (lancamento-status.js).
import { normalizarMotivo, statusLancamento, timestampIso } from '../lib/lancamento-status.js'
import { buscarFechamentoApresentadoras, dinheiroEmCentavos, ultimoDiaDoMes } from './remuneracao-apresentadoras.js'

export const COMPONENTES = Object.freeze(['fixo', 'variavel'])
// Padrões por componente: fixo vence dia 10 do próprio mês; variável (comissão + adicionais) dia 15 do mês seguinte.
export const VENCIMENTO_PADRAO = Object.freeze({
  fixo: Object.freeze({ dia: 10, mes_offset: 0 }),
  variavel: Object.freeze({ dia: 15, mes_offset: 1 }),
})
// Compat (valores do modelo antigo, pagamento único) — mantidos só para quem ainda importa.
export const VENCIMENTO_DIA_PADRAO = 10
export const VENCIMENTO_OFFSET_PADRAO = 1

export const ehComponente = (c) => COMPONENTES.includes(c)

// Competências (YYYY-MM) cujo mês intersecta [inicio, fim] (strings YYYY-MM-DD).
export function mesesDoPeriodo(inicio, fim) {
  let [a, m] = inicio.slice(0, 7).split('-').map(Number)
  const [fa, fm] = fim.slice(0, 7).split('-').map(Number)
  const out = []
  while (a < fa || (a === fa && m <= fm)) {
    out.push(`${a}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; a += 1 }
  }
  return out
}

// Vencimento: dia configurado no mês (competência + offset); dia > fim do mês => último dia.
export function vencimentoApresentadora(mes, dia = VENCIMENTO_DIA_PADRAO, offset = VENCIMENTO_OFFSET_PADRAO) {
  let [a, m] = mes.split('-').map(Number)
  m += Number(offset)
  while (m > 12) { m -= 12; a += 1 }
  const ym = `${a}-${String(m).padStart(2, '0')}`
  const d = Math.min(Number(dia), Number(ultimoDiaDoMes(ym).slice(8, 10)))
  return `${ym}-${String(d).padStart(2, '0')}`
}

// Config de vencimento por componente: { fixo:{dia,mes_offset}, variavel:{dia,mes_offset} }.
export async function buscarConfigVencimento(db, tenantId) {
  const r = await db.query(
    `SELECT apresentadoras_fixo_vencimento_dia AS fixo_dia,
            apresentadoras_fixo_vencimento_mes_offset AS fixo_offset,
            apresentadoras_variavel_vencimento_dia AS variavel_dia,
            apresentadoras_variavel_vencimento_mes_offset AS variavel_offset
       FROM tenants WHERE id = $1::uuid`, [tenantId])
  const row = r.rows[0] ?? {}
  const num = (v, d) => (v == null ? d : Number(v))
  return {
    fixo: { dia: num(row.fixo_dia, VENCIMENTO_PADRAO.fixo.dia), mes_offset: num(row.fixo_offset, VENCIMENTO_PADRAO.fixo.mes_offset) },
    variavel: { dia: num(row.variavel_dia, VENCIMENTO_PADRAO.variavel.dia), mes_offset: num(row.variavel_offset, VENCIMENTO_PADRAO.variavel.mes_offset) },
  }
}

export async function atualizarConfigVencimento(db, tenantId, { fixo = {}, variavel = {} } = {}) {
  await db.query(
    `UPDATE tenants SET
        apresentadoras_fixo_vencimento_dia = COALESCE($2::smallint, apresentadoras_fixo_vencimento_dia),
        apresentadoras_fixo_vencimento_mes_offset = COALESCE($3::smallint, apresentadoras_fixo_vencimento_mes_offset),
        apresentadoras_variavel_vencimento_dia = COALESCE($4::smallint, apresentadoras_variavel_vencimento_dia),
        apresentadoras_variavel_vencimento_mes_offset = COALESCE($5::smallint, apresentadoras_variavel_vencimento_mes_offset)
      WHERE id = $1::uuid`,
    [tenantId, fixo.dia ?? null, fixo.mes_offset ?? null, variavel.dia ?? null, variavel.mes_offset ?? null])
  return buscarConfigVencimento(db, tenantId)
}

function hojeSaoPaulo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

const dinheiro = (v) => Number(v ?? 0)

// Erro de regra de negócio com status HTTP (a rota devolve { error, code }).
const erroRegra = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode })

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const chavePg = (apId, mes, comp) => `${apId}|${mes}|${comp}`
const NOME_COMPONENTE = { fixo: 'fixo', variavel: 'variável' }

// Previsto do componente a partir de uma linha do fechamento. variável = comissão + adicionais.
export function previstoDoComponente(ap, componente) {
  if (componente === 'fixo') return r2(ap?.fixo)
  return r2(Number(ap?.comissao ?? 0) + Number(ap?.adicionais ?? 0))
}

/**
 * Dois lançamentos por pessoa/mês (quando houver valor ou baixa): componente 'fixo' e 'variavel'.
 * id = apresentadora:<uuid>:<YYYY-MM>:<componente>. Mantém fixo/comissao/adicionais do fechamento.
 */
export async function listarPagamentosApresentadoras(db, { tenantId, inicio, fim, hoje }) {
  hoje = hoje ?? hojeSaoPaulo()
  const config = await buscarConfigVencimento(db, tenantId)
  const meses = mesesDoPeriodo(inicio, fim)
  const pagos = await db.query(`
    SELECT apresentadora_id, competencia::text AS competencia, componente, valor_pago, data_pagamento::text AS data_pagamento, observacao,
           cancelado_em, cancelado_motivo, cancelado_por
      FROM apresentadora_pagamentos
     WHERE tenant_id = $1::uuid AND competencia >= $2::date AND competencia <= $3::date`,
  [tenantId, `${meses[0]}-01`, `${meses[meses.length - 1]}-01`])
  const pagoPor = new Map(pagos.rows.map((p) => [chavePg(p.apresentadora_id, p.competencia.slice(0, 7), p.componente ?? 'fixo'), p]))

  const itens = []
  for (const mes of meses) {
    const fechamento = await buscarFechamentoApresentadoras(db, { tenantId, mes })
    const vistos = new Set()
    const montar = (apresentadoraId, nome, componente, previsto, detalhe) => {
      const pg = pagoPor.get(chavePg(apresentadoraId, mes, componente))
      if (previsto <= 0 && !pg) return
      const cfg = config[componente]
      const item = {
        id: `apresentadora:${apresentadoraId}:${mes}:${componente}`,
        natureza: 'custo',
        origem: 'apresentadora',
        componente,
        apresentadora_id: apresentadoraId,
        descricao: `Pagamento ${nome} (${NOME_COMPONENTE[componente]}) - ${mes.slice(5)}/${mes.slice(0, 4)}`,
        competencia: `${mes}-01`,
        data_vencimento: vencimentoApresentadora(mes, cfg.dia, cfg.mes_offset),
        valor_previsto: previsto,
        valor_pago: pg ? dinheiro(pg.valor_pago) : 0,
        data_pagamento: pg?.data_pagamento ?? null,
        observacao: pg?.observacao ?? null,
        cancelado_em: timestampIso(pg?.cancelado_em),
        cancelado_motivo: pg?.cancelado_motivo ?? null,
        cancelado_por: pg?.cancelado_por ?? null,
        virtual: false,
        ...detalhe,
      }
      // Baixa legada (pré-172) registrava o TOTAL como 'fixo': sinaliza em vez de esconder.
      item.divergente = !item.cancelado_em && item.valor_pago > 0 && r2(item.valor_pago) > r2(item.valor_previsto)
      item.status = statusLancamento(item, hoje)
      itens.push(item)
    }
    for (const ap of fechamento.apresentadoras) {
      vistos.add(ap.apresentadora_id)
      const detalhe = { fixo: ap.fixo, comissao: ap.comissao, adicionais: ap.adicionais }
      for (const comp of COMPONENTES) montar(ap.apresentadora_id, ap.nome, comp, previstoDoComponente(ap, comp), detalhe)
    }
    // Pagamento registrado para apresentadora que saiu do fechamento (inativada/arquivada).
    const orfas = new Set()
    for (const chave of pagoPor.keys()) {
      const [apId, m] = chave.split('|')
      if (m === mes && !vistos.has(apId)) orfas.add(apId)
    }
    for (const apId of orfas) {
      const n = await db.query('SELECT nome FROM apresentadoras WHERE id = $1::uuid AND tenant_id = $2::uuid', [apId, tenantId])
      for (const comp of COMPONENTES) montar(apId, n.rows[0]?.nome ?? 'Apresentadora', comp, 0, { fixo: 0, comissao: 0, adicionais: 0 })
    }
  }
  return itens.sort((a, b) => a.competencia.localeCompare(b.competencia)
    || a.descricao.localeCompare(b.descricao, 'pt-BR') || a.componente.localeCompare(b.componente))
}

// Baixa de UM componente: default = previsto do componente. Retorna null se a apresentadora não existe no tenant.
// Upsert pela UNIQUE (tenant, apresentadora, competência, componente): repetir não gera baixa dupla.
export async function registrarPagamentoApresentadora(db, { tenantId, apresentadoraId, mes, componente = 'fixo', valorPago, dataPagamento, observacao, userId }) {
  if (!ehComponente(componente)) throw new TypeError('componente inválido')
  const ap = await db.query('SELECT id FROM apresentadoras WHERE id = $1::uuid AND tenant_id = $2::uuid', [apresentadoraId, tenantId])
  if (!ap.rows[0]) return null
  let valor = valorPago
  if (valor == null) {
    const f = await buscarFechamentoApresentadoras(db, { tenantId, mes, apresentadoraId })
    valor = previstoDoComponente(f.apresentadoras[0], componente)
  } else {
    const cents = dinheiroEmCentavos(valor)
    if (cents == null) throw new TypeError('valor_pago inválido')
    valor = cents / 100
  }
  const atual = await db.query(
    `SELECT cancelado_em FROM apresentadora_pagamentos
      WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text`,
    [tenantId, apresentadoraId, `${mes}-01`, componente])
  if (atual.rows[0]?.cancelado_em) {
    throw erroRegra('Pagamento cancelado. Reative antes de pagar.', 'CUSTO_CANCELADO')
  }
  const r = await db.query(`
    INSERT INTO apresentadora_pagamentos (tenant_id, apresentadora_id, competencia, componente, valor_pago, data_pagamento, observacao, criado_por)
    VALUES ($1::uuid, $2::uuid, $3::date, $4::text, $5::numeric, COALESCE($6::date, (now() AT TIME ZONE 'America/Sao_Paulo')::date), $7, $8::uuid)
    ON CONFLICT (tenant_id, apresentadora_id, competencia, componente)
    DO UPDATE SET valor_pago = EXCLUDED.valor_pago, data_pagamento = EXCLUDED.data_pagamento,
                  observacao = EXCLUDED.observacao, atualizado_em = now()
    RETURNING id, apresentadora_id, competencia::text AS competencia, componente, valor_pago, data_pagamento::text AS data_pagamento, observacao`,
  [tenantId, apresentadoraId, `${mes}-01`, componente, valor, dataPagamento ?? null, observacao ?? null, userId ?? null])
  return r.rows[0]
}

export async function desfazerPagamentoApresentadora(db, { tenantId, apresentadoraId, mes, componente = 'fixo' }) {
  // Linha cancelada mantém o cancelamento: só zera a baixa (data_pagamento é nullable desde a 174).
  const u = await db.query(
    `UPDATE apresentadora_pagamentos SET valor_pago = 0, data_pagamento = NULL, atualizado_em = now()
      WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text
        AND cancelado_em IS NOT NULL RETURNING id`,
    [tenantId, apresentadoraId, `${mes}-01`, componente])
  if (u.rowCount > 0) return true
  const r = await db.query(
    `DELETE FROM apresentadora_pagamentos
      WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text RETURNING id`,
    [tenantId, apresentadoraId, `${mes}-01`, componente])
  return r.rowCount > 0
}

// Item normalizado (status 'cancelado' aplicado) de um componente; resposta de cancelar/reativar.
async function itemDoComponente(db, { tenantId, apresentadoraId, mes, componente }) {
  const itens = await listarPagamentosApresentadoras(db, { tenantId, inicio: `${mes}-01`, fim: `${mes}-01` })
  return itens.find((i) => i.id === `apresentadora:${apresentadoraId}:${mes}:${componente}`) ?? null
}

// Cancela o componente (não será pago). Preserva baixa parcial; sem baixa cria a linha com valor_pago 0
// e data_pagamento NULL. null = apresentadora inexistente no tenant.
// 409 CANCELAMENTO_INVALIDO se previsto <= 0 ou já pago por inteiro. Idempotente (mantém o 1o cancelamento).
export async function cancelarPagamentoApresentadora(db, { tenantId, apresentadoraId, mes, componente = 'fixo', motivo, actorUserId = null }) {
  if (!ehComponente(componente)) throw new TypeError('componente inválido')
  const motivoNorm = normalizarMotivo(motivo)
  const ap = await db.query('SELECT id FROM apresentadoras WHERE id = $1::uuid AND tenant_id = $2::uuid', [apresentadoraId, tenantId])
  if (!ap.rows[0]) return null
  const f = await buscarFechamentoApresentadoras(db, { tenantId, mes, apresentadoraId })
  const previsto = previstoDoComponente(f.apresentadoras[0], componente)
  if (!(previsto > 0)) {
    throw erroRegra('Componente sem valor previsto não pode ser cancelado.', 'CANCELAMENTO_INVALIDO')
  }
  const atual = await db.query(
    `SELECT valor_pago FROM apresentadora_pagamentos
      WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text`,
    [tenantId, apresentadoraId, `${mes}-01`, componente])
  const pago = dinheiro(atual.rows[0]?.valor_pago)
  if (pago > 0 && r2(pago) >= previsto) {
    throw erroRegra('Componente já pago por inteiro; desfaça o pagamento antes.', 'CANCELAMENTO_INVALIDO')
  }
  await db.query(`
    INSERT INTO apresentadora_pagamentos AS ap (tenant_id, apresentadora_id, competencia, componente, valor_pago, data_pagamento, cancelado_em, cancelado_motivo, cancelado_por)
    VALUES ($1::uuid, $2::uuid, $3::date, $4::text, 0, NULL, NOW(), $5::text, $6::uuid)
    ON CONFLICT (tenant_id, apresentadora_id, competencia, componente)
    DO UPDATE SET cancelado_em = COALESCE(ap.cancelado_em, NOW()),
                  cancelado_por = CASE WHEN ap.cancelado_em IS NULL THEN EXCLUDED.cancelado_por ELSE ap.cancelado_por END,
                  cancelado_motivo = CASE WHEN ap.cancelado_em IS NULL THEN EXCLUDED.cancelado_motivo ELSE COALESCE(EXCLUDED.cancelado_motivo, ap.cancelado_motivo) END,
                  atualizado_em = now()`,
  [tenantId, apresentadoraId, `${mes}-01`, componente, motivoNorm, actorUserId])
  return itemDoComponente(db, { tenantId, apresentadoraId, mes, componente })
}

// Reativa: linha sem baixa (valor_pago = 0) é apagada (volta a virtual); com baixa parcial só limpa cancelado_*.
// null = nunca foi cancelado (404).
export async function reativarPagamentoApresentadora(db, { tenantId, apresentadoraId, mes, componente = 'fixo' }) {
  if (!ehComponente(componente)) throw new TypeError('componente inválido')
  const chave = [tenantId, apresentadoraId, `${mes}-01`, componente]
  const filtro = 'tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text AND cancelado_em IS NOT NULL'
  const del = await db.query(`DELETE FROM apresentadora_pagamentos WHERE ${filtro} AND COALESCE(valor_pago, 0) = 0 RETURNING id`, chave)
  if (!del.rowCount) {
    const up = await db.query(
      `UPDATE apresentadora_pagamentos SET cancelado_em = NULL, cancelado_motivo = NULL, cancelado_por = NULL, atualizado_em = now()
        WHERE ${filtro} RETURNING id`, chave)
    if (!up.rowCount) return null
  }
  const item = await itemDoComponente(db, { tenantId, apresentadoraId, mes, componente })
  // Sem previsto e sem baixa a linha some do fechamento: devolve o mínimo para o front invalidar.
  return item ?? { id: `apresentadora:${apresentadoraId}:${mes}:${componente}`, componente, cancelado_em: null, cancelado_motivo: null, cancelado_por: null }
}
