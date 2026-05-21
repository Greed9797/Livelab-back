import { isWeekendInSaoPaulo } from '../lib/timezone.js'

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'
export const WEEKEND_LIVE_PRESENTER_COMMISSION_PCT = 2

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export async function resolvePresenterCommissionPct(db, {
  tenantId,
  marcaId,
  apresentadoraId,
  origem,
  origemId,
  data,
  gmv,
  fallbackLivePct,
  fallbackVideoPct,
}) {
  if (!apresentadoraId) return 0

  if (origem === 'live' && data && isWeekendInSaoPaulo(data)) {
    return WEEKEND_LIVE_PRESENTER_COMMISSION_PCT
  }

  const baseGmvQ = data ? await db.query(
    `SELECT COALESCE(SUM(gmv), 0) AS gmv_mes
     FROM vendas_atribuidas
     WHERE tenant_id = $1::uuid
       AND apresentadora_id = $2::uuid
       AND date_trunc('month', data::timestamp) = date_trunc('month', $3::date::timestamp)
       AND NOT (origem = $4 AND origem_id = $5::uuid)`,
    [tenantId, apresentadoraId, data, origem, origemId ?? NIL_UUID],
  ) : { rows: [{ gmv_mes: 0 }] }
  const baseGmv = toNumber(baseGmvQ.rows[0]?.gmv_mes) + toNumber(gmv)

  const faixaQ = await db.query(
    `SELECT comissao_pct
     FROM apresentadora_comissao_faixas
     WHERE tenant_id = $1::uuid
       AND apresentadora_id = $2::uuid
       AND ativo = true
       AND gmv_inicio <= $3::numeric
       AND (gmv_fim IS NULL OR gmv_fim >= $3::numeric)
     ORDER BY gmv_inicio DESC
     LIMIT 1`,
    [tenantId, apresentadoraId, baseGmv],
  )
  if (faixaQ.rows[0]) return toNumber(faixaQ.rows[0].comissao_pct)

  if (fallbackLivePct !== undefined || fallbackVideoPct !== undefined) {
    return toNumber(origem === 'video' ? fallbackVideoPct : fallbackLivePct)
  }

  if (!marcaId) return 0

  const vinculoQ = await db.query(
    `SELECT comissao_live_pct, comissao_video_pct
     FROM apresentadora_marcas
     WHERE tenant_id = $1::uuid
       AND marca_id = $2::uuid
       AND apresentadora_id = $3::uuid
       AND ativo = true
     LIMIT 1`,
    [tenantId, marcaId, apresentadoraId],
  )
  const vinculo = vinculoQ.rows[0]
  return toNumber(origem === 'video' ? vinculo?.comissao_video_pct : vinculo?.comissao_live_pct)
}
