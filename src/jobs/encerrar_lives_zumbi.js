// Job: encerra lives 'em_andamento' que viraram zumbi.
// Critério:
//   - iniciado_em > 24h atrás (limite duro de duração operacional)
//
// Causa: lives são marcadas em_andamento ao iniciar mas nem sempre o user
// clica "Encerrar". Ficam ativas indefinidamente, connector TikTok tenta
// reconectar a cada 60s e gera log spam UserOfflineError.

import * as connectorManager from '../services/tiktok-connector-manager.js'

const TICK_CRON = '5 */1 * * *' // 5min após cada hora cheia

let _running = false

export async function runEncerrarLivesZumbiTick(app) {
  if (_running) {
    app.log?.warn?.('[encerrar zumbi] tick anterior em andamento, pulando')
    return { skipped: true }
  }
  _running = true
  const results = { encerradas: 0, errors: 0 }

  try {
    const targets = await app.db.query(
      `SELECT l.id,
              l.tenant_id,
              l.cabine_id,
              l.iniciado_em,
              (SELECT MAX(captured_at)
                 FROM live_snapshots
                WHERE live_id = l.id
                  AND tenant_id = l.tenant_id) AS last_snapshot_at
         FROM lives l
        WHERE l.status = 'em_andamento'
          AND l.iniciado_em < NOW() - INTERVAL '24 hours'
        LIMIT 100`,
    )

    for (const live of targets.rows) {
      const client = await app.db.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [live.tenant_id])
        const upLive = await client.query(
          `UPDATE lives AS target
              SET status='encerrada',
                  encerrado_em = LEAST(
                    NOW(),
                    l.iniciado_em + INTERVAL '24 hours',
                    COALESCE($3::timestamptz, l.iniciado_em + INTERVAL '24 hours')
                  )
             FROM lives l
             WHERE target.id=$1::uuid
               AND target.tenant_id=$2::uuid
               AND target.status='em_andamento'
               AND target.id = l.id
               AND target.tenant_id = l.tenant_id
           RETURNING target.id`,
          [live.id, live.tenant_id, live.last_snapshot_at],
        )
        if (upLive.rowCount === 0) {
          await client.query('ROLLBACK')
          continue
        }
        if (live.cabine_id) {
          await client.query(
            `UPDATE cabines SET status='disponivel', live_atual_id=NULL
               WHERE id=$1::uuid AND tenant_id=$2::uuid AND live_atual_id=$3::uuid`,
            [live.cabine_id, live.tenant_id, live.id],
          )
        }
        try {
          await client.query(
            `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
               VALUES ($1::uuid, NULL, 'live.auto_encerrada_zumbi', 'lives', $2::uuid, '{}'::jsonb)`,
            [live.tenant_id, live.id],
          )
        } catch (auditErr) {
          app.log?.warn?.({ err: auditErr }, '[encerrar zumbi] audit log falhou (não-bloqueante)')
        }
        await client.query('COMMIT')

        // Para connector in-memory pra parar reconexões
        try {
          await connectorManager.stop?.(live.id)
        } catch (stopErr) {
          app.log?.warn?.({ err: stopErr, liveId: live.id }, '[encerrar zumbi] connector stop falhou')
        }

        results.encerradas += 1
        app.log?.info?.({ liveId: live.id, cabineId: live.cabine_id },
          '[encerrar zumbi] live auto-encerrada')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        results.errors += 1
        app.log?.error?.({ err, liveId: live.id }, '[encerrar zumbi] falha ao encerrar')
      } finally {
        client.release()
      }
    }
  } catch (err) {
    app.log?.error?.({ err }, '[encerrar zumbi] tick falhou')
    results.errors += 1
  } finally {
    _running = false
  }

  if (results.encerradas > 0 || results.errors > 0) {
    app.log?.info?.({ ...results }, '[encerrar zumbi] tick concluído')
  }
  return results
}

export function startEncerrarLivesZumbi(app, cron) {
  cron.schedule(TICK_CRON, async () => {
    await runEncerrarLivesZumbiTick(app)
  })
  app.log?.info?.({ schedule: TICK_CRON }, '[encerrar zumbi] cron registrado (1h)')
}
