import fs from 'fs'
import path from 'path'
import pg from 'pg'
import 'dotenv/config'

import { resolveDbSslConfig } from '../src/utils/db-ssl.js'

const BASE_MIGRATIONS = [
  '001_create_users.sql',
  '002_create_refresh_tokens.sql',
  '003_create_clientes.sql',
  '004_create_contratos.sql',
  '005_create_custos.sql',
  '006_create_cabines.sql',
  '007_create_lives.sql',
  '008_create_leads.sql',
  '009_create_boletos.sql',
  '010_create_recomendacoes.sql',
  '011_create_manuais.sql',
  '012_add_tiktok_tokens_to_tenants.sql',
  '013_create_live_snapshots.sql',
  '014_create_live_products.sql',
  '015_geocoding_contratos.sql',
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
  return new Set(rows.map((row) => row.version))
}

async function applyMigration(client, fileName) {
  const filePath = path.join(process.cwd(), 'migrations', fileName)
  if (!fs.existsSync(filePath)) throw new Error(`[fresh-schema] Arquivo não encontrado: ${fileName}`)

  const sql = fs.readFileSync(filePath, 'utf8')
  console.log(`[fresh-schema] Aplicando: ${fileName}`)

  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [fileName])
    await client.query('COMMIT')
    console.log(`[fresh-schema] OK ${fileName}`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw new Error(`[fresh-schema] Falha em ${fileName}: ${err.message}`)
  }
}

export async function setupFreshSchema() {
  if (process.env.ALLOW_FRESH_SCHEMA_SETUP !== 'true') {
    throw new Error('setup_fresh_schema exige ALLOW_FRESH_SCHEMA_SETUP=true')
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveDbSslConfig(process.env.DATABASE_URL),
    max: 2,
  })

  const client = await pool.connect()
  try {
    await ensureMigrationsTable(client)
    const applied = await getAppliedMigrations(client)
    for (const migration of BASE_MIGRATIONS) {
      if (!applied.has(migration)) await applyMigration(client, migration)
    }
    console.log('[fresh-schema] Schema base pronto.')
  } finally {
    client.release()
    await pool.end()
  }
}

const isMain = process.argv[1]?.endsWith('setup_fresh_schema.js')
if (isMain) {
  await setupFreshSchema()
}
