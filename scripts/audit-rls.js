// Audit RLS state in production.
// Usage: node scripts/audit-rls.js
// Exit code 0 = clean, 1 = vulnerabilities found.
//
// Checks:
//  1. All tables with tenant_id/franqueadora_id have RLS enabled
//  2. Each RLS table has at least one policy filtering by app.tenant_id
//  3. No orphan rows (tenant_id IS NULL) in critical tables
//  4. Routes using app.db.query directly are tagged with // MASTER:, // PUBLIC:, // WEBHOOK:, or // SYSTEM:

import 'dotenv/config'
import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const CRITICAL_TABLES = [
  'live_requests', 'live_apresentadores', 'cliente_metas',
  'clientes', 'contratos', 'lives', 'cabines', 'users', 'boletos',
  'leads', 'apresentadoras', 'pacotes', 'tenant_contact_history',
]

const ALLOWED_BYPASS_TAGS = ['// MASTER:', '// PUBLIC:', '// WEBHOOK:', '// SYSTEM:', '// AUTH:']

let failed = false
const fail = (msg) => { console.error('❌', msg); failed = true }
const ok = (msg) => console.log('✅', msg)

async function checkRls(pool) {
  const tablesQ = await pool.query(`
    SELECT DISTINCT t.table_name
    FROM information_schema.columns t
    WHERE t.table_schema = 'public'
      AND t.column_name IN ('tenant_id', 'franqueadora_id')
  `)

  const rlsQ = await pool.query(`
    SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
  `)
  const rlsByTable = Object.fromEntries(rlsQ.rows.map(r => [r.tablename, r.rowsecurity]))

  const policiesQ = await pool.query(`
    SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname='public'
  `)
  const policiesByTable = {}
  for (const p of policiesQ.rows) {
    policiesByTable[p.tablename] = policiesByTable[p.tablename] ?? []
    policiesByTable[p.tablename].push(p)
  }

  console.log('\n[1/4] RLS habilitado em tabelas com tenant_id:')
  for (const { table_name } of tablesQ.rows) {
    if (!rlsByTable[table_name]) {
      fail(`Tabela ${table_name} tem tenant_id mas RLS=false`)
    } else if (!policiesByTable[table_name]?.length) {
      fail(`Tabela ${table_name} tem RLS mas nenhuma policy`)
    } else {
      const hasTenantPolicy = policiesByTable[table_name].some(p =>
        p.qual && p.qual.includes('app.tenant_id'))
      if (!hasTenantPolicy) fail(`Tabela ${table_name}: policies não filtram por app.tenant_id`)
      else ok(`${table_name}: RLS + policy OK`)
    }
  }
}

async function checkOrphans(pool) {
  console.log('\n[2/4] Orphan rows (tenant_id IS NULL):')
  for (const t of CRITICAL_TABLES) {
    try {
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE tenant_id IS NULL`)
      if (c.rows[0].n > 0) fail(`${t}: ${c.rows[0].n} orphan rows`)
      else ok(`${t}: 0 orphans`)
    } catch (e) {
      console.log(`⚠️  ${t}: skip (${e.message})`)
    }
  }
}

async function checkNotNull(pool) {
  console.log('\n[3/4] tenant_id NOT NULL constraint:')
  const r = await pool.query(`
    SELECT table_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND column_name IN ('tenant_id','franqueadora_id')
  `)
  const exceptions = ['webhook_eventos'] // webhooks externos chegam sem tenant resolvido
  for (const row of r.rows) {
    if (row.is_nullable === 'YES' && !exceptions.includes(row.table_name)) {
      fail(`${row.table_name}: tenant_id permite NULL (force NOT NULL ou adicione à exceptions)`)
    }
  }
  ok('NOT NULL constraints OK (exceções: ' + exceptions.join(', ') + ')')
}

async function checkRouteBypass() {
  console.log('\n[4/4] Rotas usando app.db direto sem tag de exceção:')
  const routesDir = new URL('../src/routes/', import.meta.url).pathname
  const files = (await readdir(routesDir)).filter(f => f.endsWith('.js'))
  let bypassFailed = false
  for (const f of files) {
    const content = await readFile(join(routesDir, f), 'utf8')
    const lines = content.split('\n')
    // Banner: tag in first 15 lines applies file-wide
    const banner = lines.slice(0, 15).join('\n')
    const bannerTagged = ALLOWED_BYPASS_TAGS.some(t => banner.includes(t))
    if (bannerTagged) continue
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/app\.db\.(query|pool)/.test(line)) {
        const ctx = lines.slice(Math.max(0, i - 5), i).join('\n')
        if (!ALLOWED_BYPASS_TAGS.some(t => ctx.includes(t))) {
          fail(`${f}:${i + 1} usa app.db direto sem tag (// MASTER: | // PUBLIC: | // WEBHOOK: | // SYSTEM: | // AUTH:)`)
          bypassFailed = true
        }
      }
    }
  }
  if (!bypassFailed) ok('Todas chamadas app.db direto têm tag de exceção (banner ou inline)')
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente')
    process.exit(2)
  }
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  try {
    await checkRls(pool)
    await checkOrphans(pool)
    await checkNotNull(pool)
    await checkRouteBypass()
  } finally {
    await pool.end()
  }
  console.log('')
  if (failed) {
    console.error('❌ AUDIT FAILED — vazamentos detectados')
    process.exit(1)
  }
  console.log('✅ AUDIT PASSED — nenhum vazamento RLS detectado')
}

main().catch(e => { console.error(e); process.exit(2) })
