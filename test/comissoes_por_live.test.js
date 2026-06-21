import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { comissoesRoutes } from '../src/routes/comissoes.js'

function buildApp(queryMock) {
  const app = Fastify()
  const releaseMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('db', { query: queryMock })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return app
}

describe('GET /v1/lives/:id/comissoes', () => {
  it('returns comissoes trio for a live', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'va-1',
          gmv: '1000',
          comissao_apresentadora: '10',
          comissao_franquia: '100',
          comissao_franqueadora: '20',
          pct_apresentadora: '1.00',
          status_aprovacao: 'pendente_aprovacao',
          marca_id: 'marca-uuid-1',
          marca_nome: 'Marca Teste',
          apresentadora_id: 'apres-uuid-1',
          apresentadora_nome: 'Ana Silva',
        },
      ],
    })

    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const liveId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const response = await app.inject({
      method: 'GET',
      url: `/v1/lives/${liveId}/comissoes`,
    })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(payload.live_id).toBe(liveId)
    expect(payload.comissoes).toHaveLength(1)
    expect(payload.comissoes[0]).toMatchObject({
      gmv: 1000,
      comissao_apresentadora: 10,
      comissao_franquia: 100,
      comissao_franqueadora: 20,
      pct_apresentadora: 1,
      marca_nome: 'Marca Teste',
      apresentadora_nome: 'Ana Silva',
      status_aprovacao: 'pendente_aprovacao',
    })

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain("va.origem = 'live'")
    expect(sql).toContain('va.origem_id = $2::uuid')
    expect(sql).toContain('pct_apresentadora')
  })

  it('returns 200 with empty/pendente when no comissoes exist yet (não é erro)', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/lives/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/comissoes',
    })

    // Comissão ainda não calculada não deve quebrar o "ver detalhes": 200 + lista vazia.
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ comissoes: [], pendente: true })
  })
})

describe('GET /v1/comissoes/por-live', () => {
  it('returns vendas atribuídas list for given month', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          live_id: 'live-uuid-1',
          data: '2026-05-10',
          gmv: '2000',
          comissao_apresentadora: '20',
          comissao_franquia: '200',
          comissao_franqueadora: '40',
          pct_aplicado: '1.00',
          status_aprovacao: 'pendente_aprovacao',
          marca_nome: 'Marca Alpha',
          apresentadora_nome: 'Bia Costa',
        },
      ],
    })

    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/comissoes/por-live?mes=2026-05',
    })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(Array.isArray(payload)).toBe(true)
    expect(payload).toHaveLength(1)
    expect(payload[0]).toMatchObject({
      live_id: 'live-uuid-1',
      gmv: 2000,
      comissao_apresentadora: 20,
      pct_aplicado: 1,
      marca_nome: 'Marca Alpha',
      apresentadora_nome: 'Bia Costa',
    })

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain("va.origem = 'live'")
    expect(sql).toContain("to_char(va.data::date, 'YYYY-MM') = $2")
    expect(sql).toContain('ORDER BY va.data DESC')
  })

  it('returns 400 when mes param is missing', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/comissoes/por-live',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: expect.stringContaining('mes') })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('returns 400 when mes param has wrong format', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/comissoes/por-live?mes=05-2026',
    })

    expect(response.statusCode).toBe(400)
  })
})
