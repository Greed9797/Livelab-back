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

  // Pool "quente": abrir conexão nova custa caro porque a API (Railway us-west)
  // fica longe do banco (Supabase sa-east) — o handshake TLS cross-region é de
  // centenas de ms. Com idleTimeout de 30s as conexões morriam entre requests e
  // quase toda chamada pagava handshake. Mantemos um mínimo aquecido e só
  // descartamos conexões após 10min ociosas.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig,
    max: Number(process.env.DB_POOL_MAX ?? 20),
    min: Number(process.env.DB_POOL_MIN ?? 4),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS ?? 600_000),
    connectionTimeoutMillis: 8000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
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
  // Teto de conexões que UM handler pode tomar de uma vez. Sem isso, um único
  // /home/dashboard (~20 queries) tomaria o pool inteiro e faria os outros
  // usuários esperarem. As excedentes apenas aguardam uma vaga.
  const PARALLEL_MAX = Number(process.env.DB_TENANT_PARALLEL_MAX ?? 8)

  app.decorate('tenantParallel', (tenantId) => {
    let ativos = 0
    const fila = []
    const vaga = () => (ativos < PARALLEL_MAX
      ? (ativos++, Promise.resolve())
      : new Promise((resolve) => fila.push(resolve)))
    const libera = () => {
      const proximo = fila.shift()
      if (proximo) proximo()
      else ativos--
    }

    return {
      query: async (text, params) => {
        await vaga()
        const client = await pool.connect()
        try {
          await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
          return await client.query(text, params)
        } finally {
          client.release()
          libera()
        }
      },
    }
  })

  app.addHook('onClose', async () => pool.end())
}

export default fp(dbPlugin, { name: 'db' })
export { dbPlugin }
