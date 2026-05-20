import pg from 'pg'
import fs from 'fs'
import path from 'path'
import 'dotenv/config'

import { resolveDbSslConfig } from './src/utils/db-ssl.js'

// Lista parte da 016 — migrations 001-015 foram aplicadas no banco original
// e existem em migrations/ apenas como histórico. Para banco novo (fresh setup
// dev/staging/restore), aplicar 001-015 manualmente antes deste script ou
// criar setup_fresh.js dedicado.
//
// Gap 027/028: numeros pulados intencionalmente — versionamento descontínuo
// durante refactor de schema, sem migrations correspondentes.
export const MIGRATIONS_LIST = [
  '016_auditoria_implantacao.sql',
  '017_cabines_reservas_eventos.sql',
  '018_lives_analytics_indexes.sql',
  '019_asaas_integration.sql',
  '020_asaas_integration_fixes.sql',
  '021_tiktok_live_connector.sql',
  '022_tenant_settings.sql',
  '023_billing_batch_setup.sql',
  '024_schema_fixes.sql',
  '025_create_live_requests.sql',
  '026_add_analytics_dashboard_indexes.sql',
  '029_lives_tiktok_fields.sql',
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
  '057_rename_asaas_to_gateway.sql',
  '058_webhook_replay_log.sql',
  '059_cabines_unique_numero.sql',
  '060_rls_with_check.sql',
  '061_audit_log.sql',
  '062_tenants_plano_cidade.sql',
  '063_knowledge_base_expansion.sql',
  '064_papel_expansao_cliente_notas.sql',
  '065_notification_log.sql',
  '066_tenant_notif_settings.sql',
  '069_apresentadoras_disponibilidade.sql',
  '070_user_tenant_access.sql',
  '071_password_reset_invite.sql',
  '072_users_token_version.sql',
  '073_users_atualizado_em.sql',
  '074_boletos_cliente_contrato.sql',
  '075_tiktok_cliente_username.sql',
  '076_lives_manual_metrics.sql',
  '077_clientes_soft_delete.sql',
  '078_lives_manual_metrics_ext.sql',
  '079_lives_apresentador_nullable.sql',
  '080_marcas_agenda_videos_vendas.sql',
  '081_cabines_lives_restructure.sql',
  '082_live_metric_revisions.sql',
  '083_vendas_atribuidas_aprovacao.sql',
  '084_performance_indexes.sql',
  '085_agenda_operacional_campos.sql',
  '086_leads_crm_structured_history.sql',
  '087_cabines_soft_delete_columns.sql',
  '088_franqueado_sessao1_operacional.sql',
  '089_ranking_publico_config.sql',
  '090_comissao_metas_compat.sql',
  '091_lives_agenda_link.sql',
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

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
}

export async function applyMigration(client, fileName) {
  const filePath = path.join(process.cwd(), 'migrations', fileName)
  if (!fs.existsSync(filePath)) {
    console.log(`[migrations] Ignorada (arquivo não encontrado): ${fileName}`)
    return
  }

  const sql = fs.readFileSync(filePath, 'utf8')
  const requiresNoTransaction = /\bCONCURRENTLY\b/i.test(sql)
  console.log(`[migrations] Aplicando: ${fileName}`)

  if (requiresNoTransaction) {
    try {
      for (const statement of splitSqlStatements(sql)) {
        await client.query(statement)
      }
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [fileName])
      console.log(`[migrations] ✅ ${fileName}`)
      return
    } catch (err) {
      throw new Error(`[migrations] ❌ Falha em ${fileName}: ${err.message}`)
    }
  }

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
      ssl: resolveDbSslConfig(process.env.DATABASE_URL),
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
