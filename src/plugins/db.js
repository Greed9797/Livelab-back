import fp from 'fastify-plugin'
import pg from 'pg'
import 'dotenv/config'

import '../lib/pg-date-string.js' // DATE → string 'YYYY-MM-DD' (nunca Date JS)
import { resolveDbSslConfig } from '../utils/db-ssl.js'

const { Pool } = pg

async function dbPlugin(app) {
  const sslConfig = resolveDbSslConfig(process.env.DATABASE_URL)
  const sslRejectUnauthorized =
    sslConfig && typeof sslConfig === 'object' && sslConfig.rejectUnauthorized !== false

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })

  // Testa conexão na inicialização
  const client = await pool.connect()
  client.release()
  app.log.info('PostgreSQL conectado')
  if (sslConfig && !sslRejectUnauthorized) {
    app.log.warn('DB SSL certificate verification is DISABLED (DB_SSL_REJECT_UNAUTHORIZED=false)')
  }

  // Decorator para queries simples (sem tenant)
  app.decorate('db', {
    query: (text, params) => pool.query(text, params),
    pool,
  })

  // Decorator para queries com RLS (com tenant_id do JWT)
  app.decorate('dbTenant', async (tenantId) => {
    const client = await pool.connect()
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
    return {
      query: (text, params) => client.query(text, params),
      release: () => client.release(),
    }
  })

  // Wrapper que garante db.release() mesmo em erro/early-return.
  // Substitui o padrão `const db = await app.dbTenant(t); try { ... } finally { db.release() }`.
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try {
      return await fn(db)
    } finally {
      db.release()
    }
  })

  // Executor com RLS que roda queries REALMENTE em paralelo.
  //
  // Por que existe: `dbTenant` entrega UM client; várias `db.query()` dentro de
  // um Promise.all são enfileiradas nele e viram round-trips SEQUENCIAIS. Com a
  // API longe do banco (Railway us-west ↔ Supabase sa-east ≈ 180ms de RTT), um
  // handler com 20 queries paga 20×RTT ≈ 4s. Aqui cada query pega sua própria
  // conexão do pool, então o Promise.all custa ~1 RTT no total.
  //
  // Cada conexão recebe seu próprio set_config antes da query — nunca reusa o
  // tenant de uma conexão anterior (evita vazamento entre tenants).
  app.decorate('tenantParallel', (tenantId) => ({
    query: async (text, params) => {
      const client = await pool.connect()
      try {
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
        return await client.query(text, params)
      } finally {
        client.release()
      }
    },
  }))

  app.addHook('onClose', async () => pool.end())
}

export default fp(dbPlugin, { name: 'db' })
export { dbPlugin }
