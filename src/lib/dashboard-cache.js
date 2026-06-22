import { performance } from 'node:perf_hooks'

// ── Cache em memória reutilizável para endpoints GET pesados de dashboard ──────
// Extraído do padrão provado em routes/home.js (GET /v1/home/dashboard):
//   - Map com TTL curto (30–60s) → absorve refresh rápido / múltiplas abas.
//   - Dedup de requisições in-flight → 1 query no DB mesmo com N requests
//     concorrentes para a MESMA chave (evita thundering herd).
//   - Header Cache-Control: private, max-age=15, stale-while-revalidate=30 →
//     o browser reaproveita por 15s e serve stale enquanto revalida por +30s.
//
// IMPORTANTE: a chave de cache DEVE conter tenant_id + TODOS os parâmetros que
// alteram o resultado (período, marca_id, apresentadora_id, scope, origem, …).
// Caso contrário tenants/filtros se contaminariam. NUNCA usar em POST/PATCH.

const BROWSER_MAX_AGE_SECONDS = 15
const STALE_SECONDS = 30

// Namespaces isolados por endpoint para evitar colisão de chaves entre rotas.
// Cada namespace tem seu próprio Map de valores e de promessas in-flight.
const namespaces = new Map()

function getNamespace(name) {
  let ns = namespaces.get(name)
  if (!ns) {
    ns = { cache: new Map(), inFlight: new Map() }
    namespaces.set(name, ns)
  }
  return ns
}

/**
 * Serializa um objeto de parâmetros em uma porção determinística da chave.
 * Ordena as chaves para que a ordem dos query params não gere chaves distintas;
 * ignora valores null/undefined (filtro ausente).
 */
export function buildCacheKey(tenantId, params = {}) {
  const parts = Object.keys(params)
    .sort()
    .filter((k) => params[k] !== null && params[k] !== undefined && params[k] !== '')
    .map((k) => `${k}=${params[k]}`)
  return `${tenantId}::${parts.join('&')}`
}

/**
 * Define os headers de cache + observabilidade na resposta.
 * Idêntico ao comportamento de home.js (mesmos valores e Server-Timing).
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {'HIT'|'MISS'|'DISABLED'} cacheState
 * @param {number} startedAt  marca de performance.now() do início do handler
 */
export function setCacheControl(reply, cacheState, startedAt) {
  const totalMs = Math.max(performance.now() - startedAt, 0)
  reply.header('Cache-Control', `private, max-age=${BROWSER_MAX_AGE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`)
  reply.header('X-Dashboard-Cache', cacheState)
  reply.header('Server-Timing', `cache;desc="${cacheState}", total;dur=${totalMs.toFixed(1)}`)
}

function readCache(ns, key, now) {
  const entry = ns.cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    ns.cache.delete(key)
    return null
  }
  return entry
}

/**
 * Executa `computeFn` com cache em memória + dedup de requisições in-flight.
 *
 * @param {object} opts
 * @param {string} opts.namespace  identificador do endpoint (ex.: 'analytics:dashboard')
 * @param {string} opts.key        chave já contendo tenant_id + params (ver buildCacheKey)
 * @param {number} opts.ttlMs      tempo de vida da entrada em ms (0 desativa o cache)
 * @param {() => Promise<any>} opts.computeFn  função que produz o payload (1 vez por chave)
 * @returns {Promise<{ value: any, state: 'HIT'|'MISS'|'DISABLED' }>}
 */
export async function withCache({ namespace, key, ttlMs, computeFn }) {
  const enabled = Number.isFinite(ttlMs) && ttlMs > 0
  if (!enabled) {
    return { value: await computeFn(), state: 'DISABLED' }
  }

  const ns = getNamespace(namespace)
  const cached = readCache(ns, key, Date.now())
  if (cached) {
    return { value: cached.value, state: 'HIT' }
  }

  let payloadPromise = ns.inFlight.get(key)
  if (!payloadPromise) {
    payloadPromise = Promise.resolve().then(computeFn)
    ns.inFlight.set(key, payloadPromise)
    payloadPromise.finally(() => ns.inFlight.delete(key)).catch(() => {})
  }

  const value = await payloadPromise
  ns.cache.set(key, { expiresAt: Date.now() + ttlMs, value })
  return { value, state: 'MISS' }
}

/**
 * Invalida (remove) todas as entradas de cache de um tenant. Usado por mutações
 * (aprovar/reprovar/reprocessar comissão) para que os dashboards reflitam a
 * mudança imediatamente, sem esperar o TTL expirar.
 *
 * Como buildCacheKey gera `${tenantId}::...`, removemos por prefixo. Sem
 * `namespaceNames`, varre todos os namespaces (seguro: no pior caso recomputa).
 *
 * @param {string} tenantId
 * @param {string[]} [namespaceNames]  limita a namespaces específicos
 */
export function invalidateTenant(tenantId, namespaceNames) {
  if (!tenantId) return
  const prefix = `${tenantId}::`
  const targets = namespaceNames?.length ? namespaceNames : [...namespaces.keys()]
  for (const name of targets) {
    const ns = namespaces.get(name)
    if (!ns) continue
    for (const key of ns.cache.keys()) {
      if (key.startsWith(prefix)) ns.cache.delete(key)
    }
  }
}

// Test helper — limpa todo o estado entre testes (não usado em produção).
export function _clearDashboardCache() {
  namespaces.clear()
}
