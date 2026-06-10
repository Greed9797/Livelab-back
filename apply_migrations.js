import pg from 'pg'
import fs from 'fs'
import path from 'path'
import 'dotenv/config'

const pool = new pg.Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function runMigration(fileName) {
  const filePath = path.join(process.cwd(), 'migrations', fileName)
  if (!fs.existsSync(filePath)) {
    console.log(`Migration ignorada (não encontrada): ${fileName}`)
    return
  }

  const sql = fs.readFileSync(filePath, 'utf8')
  try {
    console.log(`Aplicando ${fileName}...`)
    await pool.query(sql)
    console.log(`✅ ${fileName} aplicada com sucesso!`)
  } catch (err) {
    console.error(`❌ Erro ao aplicar ${fileName}:`, err.message)
    // Continua para a próxima para não travar o script inteiro, 
    // útil se a tabela já existir (idempotência falha em alguns casos do SQL original).
  }
}

async function main() {
  console.log('Iniciando atualização do banco de dados (Migrations)...')
  
  // Vamos garantir as últimas migrations do SaaS
  const pendingMigrations = [
    '016_auditoria_implantacao.sql',
    '017_cabines_reservas_eventos.sql',
    '018_lives_analytics_indexes.sql',
    '019_asaas_integration.sql',
    '020_asaas_integration_fixes.sql',
    '021_tiktok_live_connector.sql',
    '022_tenant_settings.sql',
    '023_billing_batch_setup.sql',
    '024_schema_fixes.txt',          // meta_diaria_gmv em tenants + índices FK
    '025_create_live_requests.txt',  // tabela live_requests (solicitações de live)
    '026_add_analytics_dashboard_indexes.txt',
    '029_lives_tiktok_fields.txt',   // campos TikTok em lives + live_snapshots
    '030_create_pacotes.sql',
    '031_pacotes_contratos_horas.sql',
    '032_cabines_config.sql',
    '033_add_roles_apresentador_gerente.sql',
    '034_contratos_pacote.sql',
    '035_manuais_metadata.sql',
    '036_cabines_ativo.sql',         // coluna ativo em cabines
    '037_leads_crm_mvp.sql',         // CRM MVP: etapa, valor, responsavel, historico, tarefas, ganho
    '038_pacotes_fixo_variavel.sql', // Pacotes: valor_fixo + comissao_pct separados
    '039_apresentadoras.sql',        // Tabela apresentadoras
    '040_contact_history_meta_cliente.sql', // Telefone/e-mail tenant + histórico + meta cliente + apresentadora em live_requests
    '041_apresentadoras_extra_fields.sql',  // link_contrato, data_aniversario, data_inicio, data_fim
    '042_clientes_onboarding_step.sql',     // onboarding_step + status 'onboarding' no CHECK
    '043_live_apresentadores.sql',          // Múltiplos apresentadores por live (junction table)
    '044_clientes_logo_url.sql',            // logo_url em clientes
    '045_cliente_metas.sql',               // Metas mensais de GMV por cliente
    '046_tenants_contact_fields.sql',      // telefone_contato + email_contato em tenants
    '047_onboarding.sql',                  // onboarding_completed em users + tabela onboarding_responses
    '048_users_management.sql',            // CHECK papéis expandido + user_id FK em clientes/apresentadoras + criado_por
    '049_tenants_cnpj.sql',               // coluna cnpj em tenants
    '050_lives_manual_entry.sql',         // gestor_id + resumo em lives (entrada manual)
    '052_painel_operacional.sql',         // clicks/status/problema/comissão apresentadora em lives + meta_gmv_hora/margem em clientes + RLS faltante
  ]

  for (const migration of pendingMigrations) {
    await runMigration(migration)
  }

  console.log('\nProcesso de migrations finalizado.')
}

// Exportável para uso no startup do servidor (sem fechar o pool)
export async function runMigrations() {
  await main()
}

// Execução direta via `node apply_migrations.js`
const isMain = process.argv[1]?.endsWith('apply_migrations.js')
if (isMain) {
  await main()
  await pool.end()
}
