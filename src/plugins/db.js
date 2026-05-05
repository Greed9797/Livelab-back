import fp from 'fastify-plugin'
import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

async function dbPlugin(app) {
  const sslRejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: sslRejectUnauthorized },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })

  // Testa conexão na inicialização
  const client = await pool.connect()
  client.release()
  app.log.info('PostgreSQL conectado')
  if (!sslRejectUnauthorized) {
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

  app.addHook('onClose', async () => pool.end())
}

export default fp(dbPlugin, { name: 'db' })
export { dbPlugin }
