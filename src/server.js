// src/server.js
import 'dotenv/config'
import * as Sentry from '@sentry/node'
import cron from 'node-cron'
import { buildApp } from './app.js'

// Sentry init — antes de buildApp para capturar erros de boot.
// PII redaction via beforeSend: nunca enviar senhas, tokens, body completo.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE ?? 'liveshop_saas_api@dev',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Redact PII em request body, headers e extra context
      const scrub = (obj) => {
        if (!obj || typeof obj !== 'object') return obj
        const SENSITIVE = /^(senha|password|token|authorization|x-.*-token|secret|api.?key|credit.?card|cvv|cpf|cnpj)$/i
        for (const k of Object.keys(obj)) {
          if (SENSITIVE.test(k)) obj[k] = '[redacted]'
          else if (typeof obj[k] === 'object') scrub(obj[k])
        }
        return obj
      }
      if (event.request) {
        scrub(event.request.headers)
        scrub(event.request.cookies)
        scrub(event.request.data)
      }
      scrub(event.extra)
      scrub(event.contexts)
      return event
    },
  })
}
import { TikTokService } from './services/tiktok.js'
import { cleanupOrphanContracts } from './jobs/cleanup_orphan_contracts.js'
import { cleanupPasswordResetTokens } from './jobs/cleanup_password_reset_tokens.js'
import * as connectorManager from './services/tiktok-connector-manager.js'
import { startBillingEngine } from './jobs/billing_engine.js'
import { startClienteMetricasSnapshotCron } from './jobs/cliente_metricas_snapshot.js'
import { startAgendaAutostart } from './jobs/agenda_autostart.js'
import { startRecalcularComissoes } from './jobs/recalcular_comissoes.js'
import { startEncerrarLivesZumbi } from './jobs/encerrar_lives_zumbi.js'
import { notifyBoletosVencidos } from './jobs/notify_boletos_vencidos.js'
import { runMigrations } from '../apply_migrations.js'

// Auto-create Supabase Storage bucket if not exists
const _sbUrl = process.env.SUPABASE_URL
const _sbKey = process.env.SUPABASE_SERVICE_KEY
if (_sbUrl && _sbKey) {
  fetch(`${_sbUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${_sbKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'tenant-assets', name: 'tenant-assets', public: true }),
  }).catch(() => {}) // ignore 409 already-exists
}

const app = await buildApp()
await runMigrations(app.db.pool)

// Initialize ConnectorManager with pool access and logger
connectorManager.init({ db: app.db, log: app.log })

// Initialize Billing Engine for Batch Billing
startBillingEngine(app.db.pool)

// Snapshot mensal de métricas por cliente (rolling)
startClienteMetricasSnapshotCron(app)

await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' })
console.log(`LiveShop API rodando na porta ${process.env.PORT ?? 3001}`)

// TikTok data collection every 60s:
// 1. Polling fallback (keeps live_snapshots updated even without connector)
// 2. Reconciliation loop (starts/stops connectors for ao_vivo lives)
let _pollRunning = false
cron.schedule('*/60 * * * * *', async () => {
  if (_pollRunning) {
    app.log.warn('[TikTok cron] Execução anterior ainda em andamento — ciclo pulado.')
    return
  }
  _pollRunning = true
  try {
    await TikTokService.pollAllTenants(app.db)
  } catch (err) {
    app.log.error({ err }, 'TikTok polling falhou')
  }
  try {
    await connectorManager.syncLives()
  } catch (err) {
    app.log.error({ err }, 'connectorManager.syncLives falhou')
  } finally {
    _pollRunning = false
  }
})

// Agenda auto-start: agenda_eventos status='planejado' viram 'ao_vivo'
// quando bate horário (cada 30s). Ver src/jobs/agenda_autostart.js.
startAgendaAutostart(app, cron)

// Recálculo de comissões zeradas: vendas_atribuidas com comissao_apresentadora=0
// e gmv>0 são recalculadas a cada 10min. Cobre vendas inseridas via webhook ou
// snapshot pós-encerramento que não dispararam commission-engine.
startRecalcularComissoes(app, cron)

// Auto-encerrar lives 'em_andamento' que viraram zumbi (>24h sem snapshot
// recente). Mitiga UserOfflineError loop no connector TikTok.
startEncerrarLivesZumbi(app, cron)

// Daily at 02:00: refresh TikTok OAuth tokens expiring within 7 days
cron.schedule('0 2 * * *', async () => {
  try {
    await TikTokService.refreshAllExpiringTokens(app.db)
  } catch (error) {
    app.log.error({ error }, 'Falha no refresh de tokens TikTok')
  }
})

// Daily cleanup of rejected contracts without franqueado decision for 5 days
cron.schedule('0 3 * * *', async () => {
  try {
    await cleanupOrphanContracts(app)
  } catch (error) {
    app.log.error({ error }, 'Falha ao limpar contratos órfãos')
  }
})

// Daily: mark overdue boletos as 'vencido' (moved from GET /v1/boletos to avoid mutating state on read)
cron.schedule('0 1 * * *', async () => {
  try {
    await app.db.query(
      `UPDATE boletos SET status = 'vencido' WHERE status = 'pendente' AND vencimento < CURRENT_DATE`
    )
  } catch (error) {
    app.log.error({ error }, 'Falha ao atualizar boletos vencidos')
  }
})

// F1: 02:30 SP — notifica clientes sobre boletos vencidos (1x por boleto, dedupe via notification_log)
cron.schedule('30 2 * * *', async () => {
  try {
    await notifyBoletosVencidos(app)
  } catch (error) {
    app.log.error({ error }, 'Falha ao notificar boletos vencidos')
  }
}, { timezone: 'America/Sao_Paulo' })

// Daily 03:00 SP — housekeeping: remove password_reset_tokens > 30 days
// Job tem try/catch interno; nunca derruba o cron loop.
cron.schedule('0 3 * * *', async () => {
  try {
    await cleanupPasswordResetTokens(app)
  } catch (error) {
    app.log.error({ error }, 'Falha ao limpar password_reset_tokens')
  }
}, { timezone: 'America/Sao_Paulo' })

// Daily 03:00 SP — offsite PostgreSQL backup → S3/R2
// Only runs in production AND when BACKUP_S3_BUCKET is configured.
// Uses nohup-style detached exec to avoid blocking the event loop.
if (process.env.NODE_ENV === 'production' && process.env.BACKUP_S3_BUCKET) {
  const { exec } = await import('node:child_process')
  cron.schedule('0 3 * * *', () => {
    const scriptPath = new URL('../../scripts/pg_dump_offsite.sh', import.meta.url).pathname
    exec(`bash "${scriptPath}"`, { timeout: 30 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        app.log.error({ stderr: stderr?.slice(0, 500) }, '[backup] pg_dump_offsite falhou')
        return
      }
      app.log.info({ stdout: stdout?.slice(0, 500) }, '[backup] pg_dump_offsite concluído')
    })
  }, { timezone: 'America/Sao_Paulo' })
  app.log.info('[backup] pg_dump_offsite cron agendado (03:00 SP diário)')
}
