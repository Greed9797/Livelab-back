import { performance } from 'node:perf_hooks'

// ── Cache em memória reutilizável para endpoints GET pesados de dashboard ──────
// Extraído do padrão provado em routes/home.js (GET /v1/home/dashboard):
//   - Map com TTL curto (30–60s) → absorve refresh rápido / múltiplas abas.
//   - Dedup de requisições in-flight → 1 query no DB mesmo com N requests
//     concorrentes para a MESMA chave (evita thundering herd).
//   - Header Cache-Control: private, no-cache → o browser sempre pergunta ao
//     servidor. Quem entrega a velocidade é o cache em memória acima (que a
//     invalidação por evento mantém correto); um max-age no browser mascararia
//     essa invalidação, servindo lista velha logo após um PATCH.
//
// IMPORTANTE: a chave de cache DEVE conter tenant_id + TODOS os parâmetros que
// alteram o resultado (período, marca_id, apresentadora_id, scope, origem, …).
// Caso contrário tenants/filtros se contaminariam. NUNCA usar em POST/PATCH.

// Namespaces isolados por endpoint para evitar colisão de chaves entre rotas.
// Cada namespace tem seu próprio Map de valores e de promessas in-flight.
const namespaces = new Map()

function getNamespace(name) {
  let ns = namespaces.get(name)
  if (!ns) {
    // gen: contador de geração por tenant (incrementado em invalidateTenant). Um compute
    // que começou numa geração anterior à atual NÃO grava no cache (ver withCache).
    ns = { cache: new Map(), inFlight: new Map(), gen: new Map() }
    namespaces.set(name, ns)
  }
  return ns
}

/**
 * Serializa um objeto de parâmetros em uma porção determinística da chave.
 * Ordena as chaves para que a ordem dos query params não gere chaves distintas;
 * ignora valores null/undefined (filtro ausente).
 */
// tenant_id é o prefixo da chave (`${tenantId}::...`), ver buildCacheKey.
const tenantDaChave = (key) => {
  const i = String(key).indexOf('::')
  return i < 0 ? '' : String(key).slice(0, i)
}
const geracaoAtual = (ns, tenantId) => ns.gen.get(tenantId) ?? 0

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
  reply.header('Cache-Control', 'private, no-cache')
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

  const tenantId = tenantDaChave(key)
  let flight = ns.inFlight.get(key)
  if (!flight) {
    // A geração é lida ANTES de iniciar o compute: se um invalidateTenant rodar enquanto
    // ele executa, o resultado (possivelmente anterior à escrita) não pode ir para o cache.
    const entry = { gen: geracaoAtual(ns, tenantId), promise: null }
    entry.promise = Promise.resolve().then(computeFn)
    flight = entry
    ns.inFlight.set(key, entry)
    // Só remove a própria entrada: após uma invalidação outra pode ter ocupado a chave.
    entry.promise.finally(() => { if (ns.inFlight.get(key) === entry) ns.inFlight.delete(key) }).catch(() => {})
  }

  const value = await flight.promise
  if (flight.gen === geracaoAtual(ns, tenantId)) {
    ns.cache.set(key, { expiresAt: Date.now() + ttlMs, value })
  }
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
    // Nova geração: computes em andamento deixam de poder gravar; e quem chegar agora
    // não pode se juntar a um in-flight antigo (receberia o payload pré-invalidação).
    ns.gen.set(tenantId, geracaoAtual(ns, tenantId) + 1)
    for (const key of ns.cache.keys()) {
      if (key.startsWith(prefix)) ns.cache.delete(key)
    }
    for (const key of ns.inFlight.keys()) {
      if (key.startsWith(prefix)) ns.inFlight.delete(key)
    }
  }
}

// Test helper — limpa todo o estado entre testes (não usado em produção).
export function _clearDashboardCache() {
  namespaces.clear()
}
