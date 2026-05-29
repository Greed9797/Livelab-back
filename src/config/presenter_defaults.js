export const DEFAULT_APRESENTADORA_FIXO = 2700
export const MAX_APRESENTADORA_FIXO = 10000

export function presenterFixedSql(alias = 'a') {
  const column = alias ? `${alias}.fixo` : 'fixo'
  return `CASE WHEN COALESCE(${column}, 0) <= 0 OR ${column} > ${MAX_APRESENTADORA_FIXO} THEN ${DEFAULT_APRESENTADORA_FIXO} ELSE ${column} END`
}

export const DEFAULT_APRESENTADORA_COMISSAO_FAIXAS = [
  { gmv_inicio: 0, gmv_fim: 50000, comissao_pct: 0.5 },
  { gmv_inicio: 50000.01, gmv_fim: 150000, comissao_pct: 1 },
  { gmv_inicio: 150000.01, gmv_fim: 500000, comissao_pct: 1.5 },
  { gmv_inicio: 500000.01, gmv_fim: null, comissao_pct: 2 },
]

export function defaultPresenterCommissionPct(gmv) {
  const value = Number(gmv ?? 0)
  const tier = DEFAULT_APRESENTADORA_COMISSAO_FAIXAS.find((faixa) => {
    const startOk = value >= faixa.gmv_inicio
    const endOk = faixa.gmv_fim === null || value <= faixa.gmv_fim
    return startOk && endOk
  })
  return tier?.comissao_pct ?? 0
}

export async function ensureDefaultPresenterCommissionTiers(db, tenantId, apresentadoraId) {
  if (!tenantId || !apresentadoraId) return

  const existing = await db.query(
    `SELECT id
     FROM apresentadora_comissao_faixas
     WHERE tenant_id = $1::uuid
       AND apresentadora_id = $2::uuid
       AND ativo = true
     LIMIT 1`,
    [tenantId, apresentadoraId],
  )
  if (existing.rows[0]) return

  const values = [tenantId, apresentadoraId]
  const tuples = DEFAULT_APRESENTADORA_COMISSAO_FAIXAS.map((faixa) => {
    const base = values.length
    values.push(faixa.gmv_inicio, faixa.gmv_fim, faixa.comissao_pct)
    return `($1::uuid, $2::uuid, $${base + 1}::numeric, $${base + 2}::numeric, $${base + 3}::numeric, true)`
  }).join(', ')

  await db.query(
    `INSERT INTO apresentadora_comissao_faixas (
       tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo
     )
     VALUES ${tuples}`,
    values,
  )
}
