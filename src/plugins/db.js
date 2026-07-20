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

  // Pool de SISTEMA — atende `app.db.query` (auth, /health, crons, webhooks).
  //
  // Por que separado: `dbTenant`/`tenantParallel` (e várias rotas que pegam client
  // cru do pool) fazem `set_config('app.tenant_id', ..., false)` — escopo de
  // SESSÃO — e devolvem a conexão ao pool SEM reset. Hoje é inofensivo porque o
  // role tem BYPASSRLS. Com RLS ligada, `pool.query` de sistema pegaria uma
  // conexão qualquer, possivelmente carregando o tenant de OUTRO request, e
  // passaria a filtrar pelo tenant errado em silêncio.
  //
  // Alternativas descartadas (ambas pagam RTT no caminho quente — a API roda em
  // Railway us-west e o banco em Supabase sa-east, ≈180ms por round-trip):
  //   (b) RESET no release(): +1 RTT por request autenticado.
  //   (c) BEGIN + set_config local: +2 RTT por aquisição de conexão.
  // Um pool dedicado custa 0 RTT: a separação é estrutural, não runtime. Este
  // pool NUNCA executa set_config('app.tenant_id') — é invariante do arquivo.
  //
  // Em produção aponte DATABASE_SYSTEM_URL para um role dedicado (o único com
  // BYPASSRLS) e deixe DATABASE_URL no role NOBYPASSRLS da aplicação. Sem essa
  // variável os dois pools usam a mesma credencial e o comportamento é o de hoje.
  const systemConnectionString = process.env.DATABASE_SYSTEM_URL || process.env.DATABASE_URL
  const systemPool = new Pool({
    connectionString: systemConnectionString,
    ssl: resolveDbSslConfig(systemConnectionString),
    max: Number(process.env.DB_SYSTEM_POOL_MAX ?? 5),
    min: Number(process.env.DB_SYSTEM_POOL_MIN ?? 1),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS ?? 600_000),
    connectionTimeoutMillis: 8000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  })

  // Testa conexão na inicialização
  const client = await pool.connect()
  client.release()
  await systemPool.query('SELECT 1')
  app.log.info('PostgreSQL conectado')
  if (process.env.DATABASE_SYSTEM_URL) {
    app.log.info('Pool de sistema usando credencial dedicada (DATABASE_SYSTEM_URL)')
  }
  if (sslConfig && !sslRejectUnauthorized) {
    app.log.warn('DB SSL certificate verification is DISABLED (DB_SSL_REJECT_UNAUTHORIZED=false)')
  }

  // Decorator para queries de sistema (sem tenant) — pool limpo, ver acima.
  // `pool` (tenant pool) segue exposto em `.pool` porque rotas/jobs que pegam
  // client cru setam o próprio tenant na aquisição; a "sujeira" de GUC fica
  // contida ali e nunca alcança o caminho de sistema.
  app.decorate('db', {
    query: (text, params) => systemPool.query(text, params),
    pool,
    systemPool,
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
  const PARALLEL_MAX = Number(process.env.DB_TENANT_PARALLEL_MAX ?? 12)

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

  app.addHook('onClose', async () => {
    await Promise.all([pool.end(), systemPool.end()])
  })
}

export default fp(dbPlugin, { name: 'db' })
export { dbPlugin }
