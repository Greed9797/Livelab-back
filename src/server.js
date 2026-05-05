// src/server.js
import 'dotenv/config'
import cron from 'node-cron'
import { buildApp } from './app.js'
import { TikTokService } from './services/tiktok.js'
import { cleanupOrphanContracts } from './jobs/cleanup_orphan_contracts.js'
import * as connectorManager from './services/tiktok-connector-manager.js'
import { startBillingEngine } from './jobs/billing_engine.js'
import { startClienteMetricasSnapshotCron } from './jobs/cliente_metricas_snapshot.js'
import { runMigrations } from '../apply_migrations.js'

await runMigrations()

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
cron.schedule('*/60 * * * * *', async () => {
  try {
    await TikTokService.pollAllTenants(app.db)
  } catch (err) {
    app.log.error({ err }, 'TikTok polling falhou')
  }
  try {
    await connectorManager.syncLives()
  } catch (err) {
    app.log.error({ err }, 'connectorManager.syncLives falhou')
  }
})

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
