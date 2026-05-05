import pg from 'pg'
import fs from 'fs'
import path from 'path'
import 'dotenv/config'

const MIGRATIONS_LIST = [
  '016_auditoria_implantacao.sql',
  '017_cabines_reservas_eventos.sql',
  '018_lives_analytics_indexes.sql',
  '019_asaas_integration.sql',
  '020_asaas_integration_fixes.sql',
  '021_tiktok_live_connector.sql',
  '022_tenant_settings.sql',
  '023_billing_batch_setup.sql',
  '024_schema_fixes.txt',
  '025_create_live_requests.txt',
  '026_add_analytics_dashboard_indexes.txt',
  '029_lives_tiktok_fields.txt',
  '030_create_pacotes.sql',
  '031_pacotes_contratos_horas.sql',
  '032_cabines_config.sql',
  '033_add_roles_apresentador_gerente.sql',
  '034_contratos_pacote.sql',
  '035_manuais_metadata.sql',
  '036_cabines_ativo.sql',
  '037_leads_crm_mvp.sql',
  '038_pacotes_fixo_variavel.sql',
  '039_apresentadoras.sql',
  '040_contact_history_meta_cliente.sql',
  '041_apresentadoras_extra_fields.sql',
  '042_clientes_onboarding_step.sql',
  '043_live_apresentadores.sql',
  '044_clientes_logo_url.sql',
  '045_cliente_metas.sql',
  '046_tenants_contact_fields.sql',
  '047_onboarding.sql',
  '048_users_management.sql',
  '049_tenants_cnpj.sql',
  '050_lives_manual_entry.sql',
  '051_leads_webhook_inbound.sql',
  '052_cliente_metricas_mensais.sql',
  '053_rls_hardening.sql',
  '054_tenant_contact_history_rls.sql',
  '055_leads_dados_extras.sql',
  '056_users_email_unique_per_tenant.sql',
]

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query(`SELECT version FROM schema_migrations`)
  return new Set(rows.map((r) => r.version))
}

async function applyMigration(client, fileName) {
  const filePath = path.join(process.cwd(), 'migrations', fileName)
  if (!fs.existsSync(filePath)) {
    console.log(`[migrations] Ignorada (arquivo não encontrado): ${fileName}`)
    return
  }

  const sql = fs.readFileSync(filePath, 'utf8')
  console.log(`[migrations] Aplicando: ${fileName}`)

  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [fileName])
    await client.query('COMMIT')
    console.log(`[migrations] ✅ ${fileName}`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw new Error(`[migrations] ❌ Falha em ${fileName}: ${err.message}`)
  }
}

export async function runMigrations(externalPool) {
  const ownPool = !externalPool
  const pool =
    externalPool ??
    new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
      max: 2,
    })

  const client = await pool.connect()
  try {
    await ensureMigrationsTable(client)
    const applied = await getAppliedMigrations(client)

    const pending = MIGRATIONS_LIST.filter((m) => !applied.has(m))
    if (pending.length === 0) {
      console.log('[migrations] Nenhuma migration pendente.')
      return
    }

    console.log(`[migrations] ${pending.length} migration(s) pendente(s).`)
    for (const migration of pending) {
      await applyMigration(client, migration)
    }
    console.log('[migrations] Todas as migrations aplicadas com sucesso.')
  } finally {
    client.release()
    if (ownPool) await pool.end()
  }
}

const isMain = process.argv[1]?.endsWith('apply_migrations.js')
if (isMain) {
  await runMigrations()
}
