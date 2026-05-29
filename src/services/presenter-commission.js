import { isWeekendInSaoPaulo } from '../lib/timezone.js'
import { defaultPresenterCommissionPct } from '../config/presenter_defaults.js'

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'
export const WEEKEND_LIVE_PRESENTER_COMMISSION_PCT = 2

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Comissão da apresentadora — fonte única de verdade.
 *
 * Regras (decisão 2026-05-25, Lucas):
 *   1) Sábado/domingo (TZ America/Sao_Paulo) em LIVE → 2% fixo, sobrepõe escada.
 *   2) Caso contrário, escada cliff por GMV mensal acumulado da apresentadora
 *      (vendas_atribuidas do mês atual, exceto a venda em cálculo) + GMV desta venda:
 *        SELECT da faixa onde gmv_inicio <= base_gmv AND (gmv_fim IS NULL OR gmv_fim >= base_gmv)
 *   3) Vídeo segue a MESMA escada — comissão da apresentadora não muda por marca.
 *   4) Sem faixa configurada → fallback `defaultPresenterCommissionPct(baseGmv)` (escada do código).
 *
 * O override antigo via `apresentadora_marcas.comissao_*_pct` foi APOSENTADO:
 * comissão da apresentadora é sempre por GMV mensal, jamais por marca. O que
 * varia por marca é a comissão da Livelab (franquia/franqueadora), tratada em
 * commission-engine.js. Por isso `marcaId` / `fallback*Pct` ficam apenas como
 * parâmetros legados ignorados.
 */
export async function resolvePresenterCommissionPct(db, {
  tenantId,
  apresentadoraId,
  origem,
  origemId,
  data,
  gmv,
}) {
  if (!apresentadoraId) return 0

  if (origem === 'live' && data && isWeekendInSaoPaulo(data)) {
    return WEEKEND_LIVE_PRESENTER_COMMISSION_PCT
  }

  // GMV acumulado do mês (exclui a própria venda em recálculo p/ não duplicar).
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

  // Sem faixa cadastrada → escada padrão do código (não bloqueia comissão).
  return toNumber(defaultPresenterCommissionPct(baseGmv))
}
