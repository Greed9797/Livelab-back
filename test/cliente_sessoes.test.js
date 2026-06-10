/**
 * Testes de GET /v1/cliente/sessoes
 *
 * Endpoint em src/routes/cliente_insights.js
 * Cobre: paginação, total via COUNT OVER, 403, cliente não encontrado,
 *        clicks null-real vs zero, release garantido.
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
const CLIENTE_ROW    = { rows: [{ id: 'cli-1', nome: 'Parceiro', nicho: 'Moda' }] }
const CONFIG_LINHA   = { rows: [{ meta_gmv_hora: '500', margem_pct: '30' }] }
const CONTRATO_ATIVO = { rows: [{ id: 'ct-1', comissao_pct: '10', valor_fixo: '1000', horas_contratadas: '40', horas_consumidas: '10' }] }
const NO_ROWS        = { rows: [] }

// Uma sessão típica com total_count
function sessaoRow(overrides = {}) {
  return {
    id: 'live-1',
    iniciado_em: '2026-05-10T18:00:00-03:00',
    encerrado_em: '2026-05-10T21:00:00-03:00',
    status: 'encerrada',
    fat_gerado: '3000',
    comissao_calculada: '300',
    comissao_apresentadora_valor: '60',
    comissao_apresentadora_pct: '2',
    clicks: '150',
    views_raw: '5000',
    status_operacional: null,
    problema: null,
    proxima_acao: null,
    final_orders_count: '30',
    apresentadora_nome: 'Ana Lima',
    total_count: '1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('GET /v1/cliente/sessoes', () => {
  afterEach(() => vi.restoreAllMocks())

  // ── 1. cliente não encontrado → total 0, sessoes [] ──────────────────────
  it('cliente não encontrado → retorna total 0 e sessoes []', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()
    setQueryMock(seqMock([NO_ROWS]))  // getClienteVinculado retorna vazio

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(0)
    expect(body.sessoes).toEqual([])
    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // ── 2. 403 para papel errado ──────────────────────────────────────────────
  it('retorna 403 para papel não autorizado', async () => {
    const { app, setQueryMock } = buildApp({ papel: 'franqueado' })
    setQueryMock(seqMock([]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ── 3. resposta completa com shape correto ────────────────────────────────
  it('dados completos → shape correto do payload', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      { rows: [sessaoRow()] },
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body).toHaveProperty('periodo')
    expect(body.total).toBe(1)
    expect(body.sessoes).toHaveLength(1)

    const s = body.sessoes[0]
    expect(s.live_id).toBe('live-1')
    expect(s.gmv).toBe(3000)
    expect(s.views).toBe(5000)
    expect(s.clicks).toBe(150)
    expect(s.pedidos).toBe(30)
    expect(s.apresentadora).toBe('Ana Lima')
    expect(s).toHaveProperty('status_operacional')
    expect(s).toHaveProperty('horas')
    await app.close()
  })

  // ── 4. clicks null-real → sessao.clicks null ──────────────────────────────
  it('clicks null → sessao.clicks é null (não 0)', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      { rows: [sessaoRow({ clicks: null })] },
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(200)
    const s = res.json().sessoes[0]
    expect(s.clicks).toBeNull()
    await app.close()
  })

  // ── 5. paginação → limit/offset passados corretamente ───────────────────
  it('paginação limit/offset → total via COUNT OVER', async () => {
    const s1 = sessaoRow({ id: 'live-1', total_count: '5' })
    const s2 = sessaoRow({ id: 'live-2', total_count: '5' })
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      { rows: [s1, s2] },
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/v1/cliente/sessoes?limit=2&offset=0',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(5)           // total real via COUNT OVER
    expect(body.sessoes).toHaveLength(2) // só as 2 paginadas
    await app.close()
  })

  // ── 6. release garantido mesmo em erro ───────────────────────────────────
  it('release é chamado mesmo se a query lançar erro', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()
    const errMock = vi.fn()
      .mockResolvedValueOnce(CLIENTE_ROW)
      .mockRejectedValueOnce(new Error('db timeout'))

    setQueryMock(errMock)
    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(500)
    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // ── 7. status_operacional do banco tem prioridade sobre motor ────────────
  it('status_operacional preenchido no banco → não recalcula via motor', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      { rows: [sessaoRow({ status_operacional: 'atencao' })] },
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(200)
    const s = res.json().sessoes[0]
    // Status vem do banco, não recalculado
    expect(s.status_operacional).toBe('atencao')
    await app.close()
  })
})
