import fp from 'fastify-plugin'
import pg from 'pg'
import * as Sentry from '@sentry/node'
import 'dotenv/config'

import '../lib/pg-date-string.js' // DATE → string 'YYYY-MM-DD' (nunca Date JS)
import { resolveDbSslConfig } from '../utils/db-ssl.js'

const { Pool } = pg

// ── Teto de conexões imposto pelo pooler ──────────────────────────────────────
// O pooler do Supabase em SESSION mode (porta 5432) aceita no máximo `pool_size`
// clientes por usuário — 15 por padrão — e recusa o excedente com
// "(EMAXCONNSESSION) max clients reached in session mode". Quem pede a conexão
// recebe erro, não fila: o request vira 500.
//
// Os dois pools deste arquivo dividem essa mesma cota quando apontam para o
// mesmo servidor. Somados eles pediam 20 + 5 = 25 contra um teto de 15, então
// bastava um punhado de queries paralelas (o /home/dashboard sozinho toma até
// DB_TENANT_PARALLEL_MAX) para o dashboard falhar de forma intermitente e
// "voltar sozinho" quando as conexões eram liberadas.
//
// O clamp é aplicado sobre o valor FINAL, não sobre o default: em produção as
// variáveis DB_POOL_MAX/DB_SYSTEM_POOL_MAX podem estar setadas acima do teto.
const POOLER_MAX_CLIENTS = Number(process.env.DB_POOLER_MAX_CLIENTS ?? 15)
const POOLER_RESERVA = 2 // sobra para migrations, psql e health checks externos

/** true quando a URL aponta para o pooler do Supabase em session mode (porta 5432). */
function usaPoolerEmSessionMode(connectionString) {
  try {
    const url = new URL(connectionString)
    return url.hostname.includes('pooler.supabase.com') && url.port === '5432'
  } catch {
    return false
  }
}

/**
 * Ajusta os dois pools para caberem na cota do pooler, preservando a proporção
 * pedida e garantindo um mínimo utilizável para cada um.
 */
export function ajustarLimitesDePool({ appMax, systemMax, compartilhamPooler, limiteTotal }) {
  if (!compartilhamPooler) return { appMax, systemMax, ajustado: false }
  const orcamento = Math.max(4, limiteTotal - POOLER_RESERVA)
  if (appMax + systemMax <= orcamento) return { appMax, systemMax, ajustado: false }
  const sistema = Math.max(2, Math.min(systemMax, Math.floor(orcamento * 0.25)))
  return { appMax: Math.max(2, orcamento - sistema), systemMax: sistema, ajustado: true }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Recusa qualquer tenant que não seja um UUID ANTES de tocar na sessão do banco.
 *
 * Sem isso, `set_config('app.tenant_id', $1, false)` com null/undefined/'' grava
 * STRING VAZIA no GUC (não NULL — verificado contra o banco). Aí toda query que faz
 * `current_setting('app.tenant_id', true)::uuid` estoura
 * `22P02 invalid input syntax for type uuid: ""`, e como essas queries vivem dentro
 * de Promise.all em handlers e crons, a rejeição escapa e mata o processo.
 *
 * Falhar aqui transforma "API inteira offline" em "este request falha". A sessão
 * nunca chega a ficar num estado que envenena as próximas queries da mesma conexão.
 */
export function assertTenantId(tenantId, origem) {
  if (typeof tenantId === 'string' && UUID_RE.test(tenantId)) return tenantId
  const err = new Error(
    `tenant_id inválido em ${origem}: ${JSON.stringify(tenantId)} — esperado UUID`,
  )
  err.statusCode = 400
  err.code = 'TENANT_ID_INVALIDO'
  throw err
}

async function dbPlugin(app) {
  const sslConfig = resolveDbSslConfig(process.env.DATABASE_URL)
  const sslRejectUnauthorized =
    sslConfig && typeof sslConfig === 'object' && sslConfig.rejectUnauthorized !== false

  // Pool "quente": abrir conexão nova custa caro porque a API (Railway us-west)
  // fica longe do banco (Supabase sa-east) — o handshake TLS cross-region é de
  // centenas de ms. Com idleTimeout de 30s as conexões morriam entre requests e
  // quase toda chamada pagava handshake. Mantemos um mínimo aquecido e só
  // descartamos conexões após 10min ociosas.
  const systemConnectionStringPre = process.env.DATABASE_SYSTEM_URL || process.env.DATABASE_URL
  const limites = ajustarLimitesDePool({
    appMax: Number(process.env.DB_POOL_MAX ?? 20),
    systemMax: Number(process.env.DB_SYSTEM_POOL_MAX ?? 5),
    // Só disputam a mesma cota quando os dois vão para o mesmo pooler.
    compartilhamPooler: usaPoolerEmSessionMode(process.env.DATABASE_URL)
      && (systemConnectionStringPre === process.env.DATABASE_URL
        || usaPoolerEmSessionMode(systemConnectionStringPre)),
    limiteTotal: POOLER_MAX_CLIENTS,
  })
  if (limites.ajustado) {
    app.log.warn(
      { appMax: limites.appMax, systemMax: limites.systemMax, poolerMaxClients: POOLER_MAX_CLIENTS },
      'pools reduzidos para caber na cota do pooler em session mode (evita EMAXCONNSESSION)',
    )
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig,
    max: limites.appMax,
    min: Math.min(Number(process.env.DB_POOL_MIN ?? 4), limites.appMax),
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
  const systemConnectionString = systemConnectionStringPre
  const systemPool = new Pool({
    connectionString: systemConnectionString,
    ssl: resolveDbSslConfig(systemConnectionString),
    max: limites.systemMax,
    min: Math.min(Number(process.env.DB_SYSTEM_POOL_MIN ?? 1), limites.systemMax),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS ?? 600_000),
    connectionTimeoutMillis: 8000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  })

  // ── Por que este handler existe: sem ele o processo MORRE ────────────────────
  // `pg.Pool` é um EventEmitter e emite 'error' quando uma conexão OCIOSA quebra —
  // o pooler do Supabase derruba conexões paradas, e a rede entre Railway (us-west)
  // e Supabase (sa-east) também. EventEmitter que emite 'error' sem nenhum listener
  // relança como exceção não capturada, e o Node encerra o processo. Não é um erro
  // de request: é um evento do pool, ninguém está esperando por ele, e o `try/catch`
  // das rotas nunca chega perto.
  //
  // Isso derrubou produção (Railway CRASHED 2/2) depois que o idleTimeout subiu para
  // 10min com `min` conexões quentes: manter conexões ociosas por muito tempo é
  // justamente o que multiplica as quedas do lado do servidor.
  //
  // Logar e seguir é o comportamento correto: o `pg` já descarta a conexão quebrada
  // e abre outra na próxima aquisição. Requests em andamento nessa conexão falham
  // pelo caminho normal (a Promise da query rejeita), não por aqui.
  pool.on('error', (err) => {
    app.log.error({ err, pool: 'tenant' }, 'conexão ociosa do pool de tenant quebrou — pg vai descartá-la')
  })
  systemPool.on('error', (err) => {
    app.log.error({ err, pool: 'system' }, 'conexão ociosa do pool de sistema quebrou — pg vai descartá-la')
  })

  // O `pool.on('error')` acima só cobre conexão OCIOSA. Enquanto uma conexão está
  // EM USO (entre o connect() e o release()) o pg-pool remove o próprio listener dela
  // — `pg-pool/index.js:344` — e o pg.Client fica com ZERO listeners de 'error'. Se a
  // conexão cair nessa janela, é o mesmo EventEmitter sem ouvinte que já derrubou
  // produção uma vez, só que um nível abaixo e fora do alcance do listener do pool.
  //
  // O gancho é 'connect', emitido em `pg-pool/index.js:337` ANTES daquele
  // removeListener, e cujos listeners de terceiros o pg-pool nunca remove. Quatro
  // linhas aqui cobrem dbTenant, withTenant, tenantParallel, withAdvisoryLock e os
  // ~24 pool.connect() crus espalhados por jobs e rotas — sem precisar parear um
  // removeListener em cada um deles, que é onde vazaria listener se alguém esquecesse.
  //
  // captureException é obrigatório: com o listener no lugar a barreira do server.js
  // deixa de ver esse evento. Sem mandar pro Sentry aqui, trocaríamos um crash
  // barulhento por uma falha silenciosa — que é pior.
  const observarClient = (nome) => (client) => {
    client.on('error', (err) => {
      app.log.error({ err, pool: nome }, 'conexão EM USO quebrou (client checked-out)')
      if (process.env.SENTRY_DSN) Sentry.captureException(err)
    })
  }
  pool.on('connect', observarClient('tenant'))
  systemPool.on('connect', observarClient('system'))

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
    assertTenantId(tenantId, 'dbTenant')
    const client = await pool.connect()
    // Se o set_config falhar, quem chamou nunca recebe o objeto e portanto nunca chama
    // release(): a conexão fica presa no pool para sempre. Bastam `max` falhas para o
    // pool inteiro travar e toda rota autenticada pendurar até o timeout.
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
    } catch (err) {
      client.release()
      throw err
    }
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
  // Nunca pode passar do tamanho do pool: se um handler sozinho pudesse tomar
  // todas as conexões, o request seguinte (e o /grade que a própria home dispara
  // em paralelo) ficaria sem vaga. Deixa ~1/3 do pool livre para os demais.
  const PARALLEL_MAX = Math.max(
    2,
    Math.min(
      Number(process.env.DB_TENANT_PARALLEL_MAX ?? 12),
      Math.floor(limites.appMax * 0.66),
    ),
  )

  app.decorate('tenantParallel', (tenantId) => {
    // Valida na criação do executor, não a cada query: falha uma vez, no ponto em
    // que o chamador ainda aparece na stack, em vez de N vezes dentro do Promise.all.
    assertTenantId(tenantId, 'tenantParallel')
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
        // `pool.connect()` fica DENTRO do try/finally: quando ele rejeita (pool cheio,
        // EMAXCONNSESSION, rede caída) a vaga do semáforo precisa voltar mesmo assim.
        // Fora do try, cada falha de conexão consumia uma vaga permanentemente — depois
        // de PARALLEL_MAX falhas toda query nova ficava esperando na fila para sempre,
        // e a home passava a pendurar até o timeout do cliente em vez de dar erro.
        let client
        try {
          client = await pool.connect()
          // set_config é um round-trip inteiro. Entre Railway (us-west) e Supabase (sa-east)
          // isso custa ~180ms, e só a home dispara 23 queries — repetir o set_config numa
          // conexão que JÁ está neste tenant é metade do tempo de resposta jogada fora.
          //
          // A marca vive no objeto do client, que o pg descarta junto com a conexão; o catch
          // abaixo a limpa quando algo falha, porque depois de um erro não dá para afirmar que
          // a sessão continua com o tenant certo. Errar aqui não daria erro visível: a query
          // usa current_setting('app.tenant_id', true) e um tenant errado ou ausente vira
          // filtro silencioso — por isso a marca só é confiada quando o valor é idêntico.
          if (client.__tenantId !== tenantId) {
            await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
            client.__tenantId = tenantId
          }
          return await client.query(text, params)
        } catch (err) {
          // `client` fica indefinido quando é o próprio connect() que falha — tocar nele
          // aqui trocaria o erro real (pool cheio) por um TypeError e esconderia a causa.
          if (client) client.__tenantId = undefined
          throw err
        } finally {
          // libera() no finally de dentro: se release() estourar, a vaga do semáforo
          // ainda volta. Perder uma vaga é permanente; perder uma conexão, não.
          try {
            if (client) client.release()
          } finally {
            libera()
          }
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
