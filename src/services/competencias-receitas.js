import { calcularReceitasComerciais } from './receitas-comercial.js'
import { exactMoneyToCents, centsToExactMoney } from '../lib/money.js'
import { addMeses, ultimoDia } from './custos-plano.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const cents = (v) => exactMoneyToCents(String(v ?? '0'))
const max = (a, b) => a > b ? a : b
const dateKey = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
const key = (row) => `${dateKey(row.competencia)}:${row.componente}`
const decimal = centsToExactMoney

function monthBoundary(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(value)
}

/**
 * Reconcile materialized obligations after the caller changed a condition.
 * Caller owns BEGIN/COMMIT/ROLLBACK and tenant+brand locks. No payment, loss or
 * closed operational snapshot is changed. Missing components become explicit
 * suspensions; components restored later reuse the same title and payment IDs.
 */
export async function reconcileCondicaoReceitas(db, {
  tenantId, marcaId, start, end, operacao, previewOnly = false,
  conditionId = null, motivo = null, actorUserId = null,
} = {}) {
  const operation = ({ editar: 'update', edit: 'update', excluir: 'delete', criar: 'create' })[operacao] ?? operacao
  if (!UUID.test(String(tenantId ?? '')) || !UUID.test(String(marcaId ?? '')) ||
      !monthBoundary(start) || !monthBoundary(end) || start >= end ||
      !['update', 'delete', 'create'].includes(operation)) {
    throw Object.assign(new Error('Escopo inválido para conciliar receitas da competência'), {
      statusCode: 400, code: 'INVALID_COMPETENCIA_RECEITAS_SCOPE',
    })
  }
  // Same lock used by geração/perda/baixa virtual. Row locks below serialize
  // materialized baixa writers which lock their financial origin directly.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('receita_titulos:' || $1::text))`, [tenantId])
  const { rows } = await db.query(`
    SELECT id, competencia, componente, valor_previsto::text, valor_pago::text,
           valor_perdido::text, perdido_em, data_pagamento, data_vencimento,
           suspensao_comercial
      FROM receita_titulos
     WHERE tenant_id = $1::uuid AND marca_id = $2::uuid
       AND competencia >= $3::date AND competencia < $4::date
     ORDER BY competencia, componente, id FOR UPDATE`, [tenantId, marcaId, start, end])
  // DELETE represents an explicit gap; no fallback calculation may revive it.
  const calculated = []
  // A baseline may start in 1900. Only materialized months require monetary
  // reconciliation, and the shared calculator accepts at most 36 months.
  if (operation !== 'delete' && rows.length) {
    const lastMonth = dateKey(rows.at(-1).competencia).slice(0, 7)
    for (let first = dateKey(rows[0].competencia).slice(0, 7); first <= lastMonth;) {
      const chunkEnd = [addMeses(first, 35), lastMonth].sort()[0]
      calculated.push(...await calcularReceitasComerciais(db, { tenantId, inicio: `${first}-01`, fim: ultimoDia(chunkEnd) }))
      first = addMeses(chunkEnd, 1)
    }
  }
  const expected = new Map(calculated.filter((r) => r.marca_id === marcaId).map((r) => [key(r), r]))
  const summary = {
    titulos: rows.length, titulos_suspensos: 0, titulos_restaurados: 0,
    valor_previsto_antes: 0n, valor_previsto_depois: 0n, valor_pago_preservado: 0n,
    valor_perdido_preservado: 0n, saldo_aberto_antes: 0n, saldo_aberto_depois: 0n,
    excesso_recebido: 0n, itens: [],
  }
  for (const row of rows) {
    const gross = cents(row.valor_previsto)
    const paid = cents(row.valor_pago)
    const lost = row.valor_perdido == null
      ? (row.perdido_em ? max(gross - paid, 0n) : 0n) : cents(row.valor_perdido)
    const closed = paid + lost
    const wasSuspended = row.suspensao_comercial?.ativa === true
    const before = wasSuspended ? closed : gross
    const calc = expected.get(key(row))
    const desired = calc ? cents(calc.valor) : 0n
    // A financial loss already recorded cannot be reopened by a commercial edit.
    const legacyLost = Boolean(row.perdido_em) && row.valor_perdido == null
    const after = calc ? (legacyLost ? gross : max(desired, closed)) : closed
    const excess = calc ? max(paid - desired, 0n) : paid
    const item = {
      id: row.id, competencia: dateKey(row.competencia), componente: row.componente,
      valor_previsto_original: decimal(gross), valor_previsto_antes: decimal(before),
      valor_calculado: decimal(desired), valor_previsto_depois: decimal(after),
      valor_pago_preservado: decimal(paid), valor_perdido_preservado: decimal(lost),
      saldo_aberto_antes: decimal(max(before - closed, 0n)),
      saldo_aberto_depois: decimal(max(after - closed, 0n)), excesso_recebido: decimal(excess),
      suspenso: !calc,
    }
    summary.itens.push(item)
    for (const field of ['valor_previsto_antes', 'valor_previsto_depois', 'valor_pago_preservado',
      'valor_perdido_preservado', 'saldo_aberto_antes', 'saldo_aberto_depois', 'excesso_recebido']) summary[field] += cents(item[field])
    if (!calc) summary.titulos_suspensos++
    if (calc && wasSuspended) summary.titulos_restaurados++
    if (previewOnly) continue
    if (!calc) {
      const marker = {
        ativa: true, operacao: operation, condicao_id: conditionId,
        motivo, ator_id: actorUserId,
        valor_previsto_original: decimal(gross), valor_pago_preservado: decimal(paid),
        valor_perdido_preservado: decimal(lost), saldo_suspenso: decimal(max(gross - closed, 0n)),
      }
      await db.query(`UPDATE receita_titulos
         SET suspensao_comercial = $3::jsonb || jsonb_build_object('suspensa_em', CURRENT_TIMESTAMP),
             atualizado_em = NOW()
       WHERE tenant_id = $1::uuid AND id = $2::uuid`, [tenantId, row.id, JSON.stringify(marker)])
    } else {
      await db.query(`UPDATE receita_titulos
         SET valor_previsto = $3::numeric, suspensao_comercial = NULL,
             data_vencimento = CASE WHEN valor_pago = 0 AND data_pagamento IS NULL
               THEN $4::date ELSE data_vencimento END, atualizado_em = NOW()
       WHERE tenant_id = $1::uuid AND id = $2::uuid`, [tenantId, row.id, decimal(after), calc.data_vencimento])
    }
  }
  return Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, typeof v === 'bigint' ? decimal(v) : v]))
}
