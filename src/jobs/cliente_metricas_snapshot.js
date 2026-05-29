// Snapshot mensal de métricas por cliente.
// Roda no início de cada mês pra fechar mês anterior; pode ser chamado ad-hoc
// pra recomputar mês específico (ex: backfill).
//
// Idempotente: UPSERT em cliente_metricas_mensais.

import cron from 'node-cron'

const TZ = 'America/Sao_Paulo'

/**
 * Recalcula snapshot de UM mês pra TODOS clientes do tenant (ou todos tenants se null).
 * Resolve custoHora simplificado via tenant_settings (fallback 0).
 */
export async function snapshotMonth(app, ano, mes, { tenantId = null, log = true } = {}) {
  const params = [ano, mes]
  let tenantFilter = ''
  if (tenantId) {
    params.push(tenantId)
    tenantFilter = `AND l.tenant_id = $3`
  }

  const result = await app.db.query(
    `
    WITH base AS (
      SELECT
        l.tenant_id,
        l.cliente_id,
        COUNT(*)::int                                    AS total_lives,
        COALESCE(SUM(l.fat_gerado), 0)                   AS gmv_total,
        COALESCE(SUM(l.final_orders_count), 0)::int      AS total_pedidos,
        COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (l.encerrado_em - l.iniciado_em)) / 3600, 0)), 0) AS horas_live,
        COALESCE(SUM(l.final_peak_viewers), 0)::bigint   AS viewers_total,
        COALESCE(SUM(l.final_total_comments), 0)::bigint AS comentarios_total,
        COALESCE(SUM(l.final_total_likes), 0)::bigint    AS likes_total,
        COALESCE(SUM(l.final_total_shares), 0)::bigint   AS shares_total
      FROM lives l
      WHERE l.cliente_id IS NOT NULL
        AND l.status IN ('encerrada','em_andamento')
        AND EXTRACT(YEAR  FROM timezone('${TZ}', l.iniciado_em))::int = $1
        AND EXTRACT(MONTH FROM timezone('${TZ}', l.iniciado_em))::int = $2
        ${tenantFilter}
      GROUP BY l.tenant_id, l.cliente_id
    ),
    itens AS (
      SELECT
        l.cliente_id,
        COALESCE(SUM(lp.quantidade), 0)::int AS itens_vendidos
      FROM lives l
      JOIN live_products lp ON lp.live_id = l.id
      WHERE l.cliente_id IS NOT NULL
        AND l.status IN ('encerrada','em_andamento')
        AND EXTRACT(YEAR  FROM timezone('${TZ}', l.iniciado_em))::int = $1
        AND EXTRACT(MONTH FROM timezone('${TZ}', l.iniciado_em))::int = $2
        ${tenantFilter}
      GROUP BY l.cliente_id
    )
    INSERT INTO cliente_metricas_mensais (
      cliente_id, tenant_id, ano, mes,
      gmv_total, total_pedidos, itens_vendidos, ticket_medio,
      total_lives, horas_live,
      viewers_total, comentarios_total, likes_total, shares_total,
      valor_investido_lives, roas, fechado_em, atualizado_em
    )
    SELECT
      b.cliente_id,
      b.tenant_id,
      $1, $2,
      b.gmv_total,
      b.total_pedidos,
      COALESCE(i.itens_vendidos, 0),
      CASE WHEN b.total_pedidos > 0 THEN b.gmv_total / b.total_pedidos ELSE 0 END,
      b.total_lives,
      b.horas_live,
      b.viewers_total,
      b.comentarios_total,
      b.likes_total,
      b.shares_total,
      0, 0,
      NOW(), NOW()
    FROM base b
    LEFT JOIN itens i ON i.cliente_id = b.cliente_id
    ON CONFLICT (cliente_id, ano, mes) DO UPDATE SET
      gmv_total            = EXCLUDED.gmv_total,
      total_pedidos        = EXCLUDED.total_pedidos,
      itens_vendidos       = EXCLUDED.itens_vendidos,
      ticket_medio         = EXCLUDED.ticket_medio,
      total_lives          = EXCLUDED.total_lives,
      horas_live           = EXCLUDED.horas_live,
      viewers_total        = EXCLUDED.viewers_total,
      comentarios_total    = EXCLUDED.comentarios_total,
      likes_total          = EXCLUDED.likes_total,
      shares_total         = EXCLUDED.shares_total,
      atualizado_em        = NOW()
    RETURNING cliente_id
    `,
    params,
  )

  if (log) {
    app.log.info(
      { ano, mes, tenantId, snapshots: result.rowCount },
      '[cliente_metricas_snapshot] snapshot gerado',
    )
  }
  return result.rowCount
}

/**
 * Cron: roda diariamente às 02:30 BRT.
 * Sempre snapshota mês corrente (rolling) E mês anterior (estável).
 */
export function startClienteMetricasSnapshotCron(app) {
  cron.schedule(
    '30 2 * * *',
    async () => {
      try {
        const now = new Date()
        const sp = new Date(now.toLocaleString('en-US', { timeZone: TZ }))
        const anoAtual = sp.getFullYear()
        const mesAtual = sp.getMonth() + 1
        const prev = new Date(sp.getFullYear(), sp.getMonth() - 1, 1)
        await snapshotMonth(app, anoAtual, mesAtual)
        await snapshotMonth(app, prev.getFullYear(), prev.getMonth() + 1)
      } catch (err) {
        app.log.error({ err }, '[cliente_metricas_snapshot cron] falhou')
      }
    },
    { timezone: TZ },
  )
  app.log.info('[cliente_metricas_snapshot] cron registrado: 02:30 diário (BRT)')
}
