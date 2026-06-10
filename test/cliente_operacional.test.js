/**
 * Testes de GET /v1/cliente/operacional
 *
 * Endpoint no src/routes/cliente_insights.js
 * Cobre: clicks null → funil null, vazio, 403, status calculado, release garantido
 */

import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clienteInsightsRoutes } from '../src/routes/cliente_insights.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function buildApp({ papel = 'cliente_parceiro', userId = 'user-1', tenantId = 'tenant-1' } = {}) {
  const app = Fastify({ logger: false })
  const releaseMock = vi.fn()
  let queryMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { sub: userId, tenant_id: tenantId, papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { sub: userId, tenant_id: tenantId, papel }
    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Acesso não autorizado' })
    }
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
  app.decorate('withTenant', async (tid, fn) => {
    const db = await app.dbTenant(tid)
    try { return await fn(db) } finally { db.release() }
  })

  return { app, releaseMock, setQueryMock: (fn) => { queryMock = fn } }
}

function seqMock(responses) {
  let i = 0
  return vi.fn().mockImplementation(() => {
    const r = responses[i] ?? { rows: [] }
    i++
    return Promise.resolve(r)
  })
}

// Respostas base reutilizáveis
const CLIENTE_ROW   = { rows: [{ id: 'cli-1', nicho: 'Moda', nome: 'Parceiro' }] }
const CONFIG_LINHA  = { rows: [{ meta_gmv_hora: '500', margem_pct: '30' }] }
const CONTRATO_ATIVO = { rows: [{ id: 'ct-1', comissao_pct: '10', valor_fixo: '1000' }] }
const NO_ROWS       = { rows: [] }

// Métricas base com tudo preenchido
const METRICS_COMPLETO = {
  rows: [{
    horas_live:                '3.00',
    gmv:                       '1500',
    comissao_livelab_total:    '150',
    comissao_apresentadora_total: '30',
    views:                     '5000',
    clicks:                    '300',
    pedidos:                   '25',
    primeiro_problema:         null,
  }],
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('GET /v1/cliente/operacional', () => {
  afterEach(() => vi.restoreAllMocks())

  // ── 1. clicks todos null → funil.clicks null (não 0) ─────────────────────
  it('clicks todos null → funil.clicks é null', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      {
        rows: [{
          horas_live: '2.00', gmv: '3000',
          comissao_livelab_total: '300', comissao_apresentadora_total: null,
          views: '5000', clicks: null,
          pedidos: '40', primeiro_problema: null,
        }],
      },
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metricas.funil.clicks).toBeNull()
    expect(body.metricas.funil.views).toBe(5000)
    expect(body.metricas.funil.pedidos).toBe(40)

    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // ── 2. Resposta completa — verifica shape do payload ─────────────────────
  it('dados completos → shape correto do payload', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      METRICS_COMPLETO,
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional?mes=6&ano=2026' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.periodo).toEqual({ mes: 6, ano: 2026 })
    expect(body.config.meta_gmv_hora).toBe(500)
    expect(body.config.comissao_livelab_pct).toBe(10)
    expect(body.metricas.horas_live).toBe(3)
    expect(body.metricas.gmv).toBe(1500)
    expect(body.metricas.gmv_por_hora).toBe(500)
    expect(body.metricas.comissao_livelab_total).toBe(150)
    expect(body.status).toHaveProperty('status')
    expect(['ok', 'atencao', 'critico', 'dados_incompletos']).toContain(body.status.status)

    await app.close()
  })

  // ── 3. 403 para papel diferente de cliente_parceiro ───────────────────────
  it('papel diferente de cliente_parceiro → 403', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ── 4. Usuário sem cliente vinculado → empty payload (não 404) ────────────
  it('usuário sem cliente vinculado → empty payload com dados_incompletos', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      NO_ROWS, // getClienteVinculado retorna null
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metricas.gmv).toBe(0)
    expect(body.metricas.funil.clicks).toBeNull()
    expect(body.status.status).toBe('dados_incompletos')

    await app.close()
  })

  // ── 5. Contrato null → comissao_livelab_pct null ─────────────────────────
  it('sem contrato ativo → comissao_livelab_pct null', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      NO_ROWS, // sem contrato
      METRICS_COMPLETO,
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })
    expect(res.statusCode).toBe(200)
    expect(res.json().config.comissao_livelab_pct).toBeNull()

    await app.close()
  })

  // ── 6. meta_gmv_hora default = 500 quando clientes não tem config ─────────
  it('clientes sem meta_gmv_hora → default 500', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      { rows: [{ meta_gmv_hora: null, margem_pct: null }] }, // sem config
      CONTRATO_ATIVO,
      METRICS_COMPLETO,
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })
    expect(res.statusCode).toBe(200)
    expect(res.json().config.meta_gmv_hora).toBe(500)
    expect(res.json().config.margem_pct).toBeNull()

    await app.close()
  })

  // ── 7. release é chamado mesmo quando a query falha ──────────────────────
  it('release é chamado mesmo quando a query falha', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      Promise.reject(new Error('DB error')),
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })
    expect(res.statusCode).toBe(500)
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })
})
