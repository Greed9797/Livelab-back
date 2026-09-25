import { activeLiveSql } from './live-merge-sql.js'
import { liveGmvSql } from './metric-sql.js'

export const LIVE_COUNT_TZ = 'America/Sao_Paulo'

/** Archived rows stay in the database and leave every count and every sum. */
export function notArchivedSql(alias = 'l') {
  return `${alias}.arquivada_em IS NULL`
}

/** One ended, active, not-archived live. Brand, unit and LiveLab counts. */
export function officialEndedLiveSql(alias = 'l') {
  return `${alias}.status = 'encerrada' AND ${activeLiveSql(alias)} AND ${notArchivedSql(alias)}`
}

/**
 * Inclusive local dates on a timestamptz, America/Sao_Paulo.
 * Cast to timestamp before AT TIME ZONE so session UTC does not shift the edge.
 */
export function saoPauloInclusiveRangeSql(column, fromParam = '$1', toParam = '$2') {
  return `${column} >= (${fromParam}::timestamp) AT TIME ZONE '${LIVE_COUNT_TZ}'
    AND ${column} < ((${toParam}::timestamp) + INTERVAL '1 day') AT TIME ZONE '${LIVE_COUNT_TZ}'`
}

/**
 * Presenter credit. If live_apresentadoras_v2 has any row, only those holders
 * match. Otherwise the live's user matches. Agenda does not.
 * apresentadoraExpr is apresentadoras.id (a column or a cast parameter).
 */
export function presenterCreditedSql(alias, apresentadoraExpr) {
  return `(
    EXISTS (
      SELECT 1 FROM live_apresentadoras_v2 lav_credit
      WHERE lav_credit.live_id = ${alias}.id
        AND lav_credit.tenant_id = ${alias}.tenant_id
        AND lav_credit.apresentadora_id = ${apresentadoraExpr}
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM live_apresentadoras_v2 lav_any
        WHERE lav_any.live_id = ${alias}.id
          AND lav_any.tenant_id = ${alias}.tenant_id
      )
      AND EXISTS (
        SELECT 1 FROM apresentadoras ap_credit
        WHERE ap_credit.tenant_id = ${alias}.tenant_id
          AND ap_credit.user_id = ${alias}.apresentador_id
          AND ap_credit.id = ${apresentadoraExpr}
      )
    )
  )`
}

/**
 * One row per rateio holder, or one row for the live user when no rateio exists.
 * presenterParam, when set, is a SQL uuid expression such as `$4::uuid`.
 * NULL keeps every credited presenter. The join stays LEFT so a live with nobody
 * credited can still count once for the brand.
 */
export function presenterFanoutSql({ live = 'l', rateio = 'ap_v2', presenterParam = null, withName = false } = {}) {
  const holderFilter = presenterParam
    ? `AND (${presenterParam} IS NULL OR lav.apresentadora_id = ${presenterParam})`
    : ''
  const userFilter = presenterParam
    ? `AND (${presenterParam} IS NULL OR ap_only.id = ${presenterParam})`
    : ''
  const nameSelect = withName ? ', a.nome' : ''
  const nameJoin = withName
    ? 'JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id'
    : ''
  const userName = withName ? ', ap_only.nome' : ''
  return `LEFT JOIN LATERAL (
    SELECT lav.apresentadora_id, lav.gmv_rateado, lav.segundos_rateio,
           lav.percentual_rateio, lav.papel, TRUE AS from_rateio${nameSelect}
    FROM live_apresentadoras_v2 lav
    ${nameJoin}
    WHERE lav.live_id = ${live}.id AND lav.tenant_id = ${live}.tenant_id
      ${holderFilter}
    UNION ALL
    SELECT ap_only.id, NULL::numeric, NULL::int, NULL::numeric, NULL::text, FALSE${userName}
    FROM apresentadoras ap_only
    WHERE ap_only.tenant_id = ${live}.tenant_id
      AND ap_only.user_id = ${live}.apresentador_id
      AND NOT EXISTS (
        SELECT 1 FROM live_apresentadoras_v2 lav_any
        WHERE lav_any.live_id = ${live}.id AND lav_any.tenant_id = ${live}.tenant_id
      )
      ${userFilter}
  ) ${rateio} ON true`
}

/** Holder share when rateio exists; the whole live when the user is the only credit. */
export function presenterGmvShareSql(live = 'l', rateio = 'ap_v2') {
  const gmv = liveGmvSql(live)
  return `CASE
    WHEN ${rateio}.from_rateio THEN COALESCE(
      ${rateio}.gmv_rateado,
      ${gmv} * ${rateio}.percentual_rateio / 100.0,
      CASE WHEN ${rateio}.papel = 'principal' THEN ${gmv} ELSE 0 END
    )
    ELSE ${gmv}
  END`
}
