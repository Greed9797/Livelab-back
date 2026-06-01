// PATCH /v1/lives/:id/publicar valida marca + chama commission-engine.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

const calcularMock = vi.fn()
vi.mock('../src/services/commission-engine.js', () => ({
  calcularComissoesDaLive: calcularMock,
}))

const { livesRoutes } = await import('../src/routes/lives.js')

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveId = '22222222-2222-4222-8222-222222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'

function buildApp({ liveRow }) {
  const app = Fastify()
  const release = vi.fn()
  const query = vi.fn(async (sql) => {
    const s = String(sql)
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] }
    if (s.includes('SELECT id, status_publicacao, marca_id, ads_gmv, manual_gmv, fat_gerado FROM lives')) {
      return { rows: [liveRow] }
    }
    if (s.includes('UPDATE lives SET status_publicacao')) {
      return { rows: [{ id: liveId, status_publicacao: 'publicado' }] }
    }
    return { rows: [] }
  })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => {
    try { return await fn({ query }) } finally { release() }
  })
  app.decorate('audit', { log: async () => {} })
  app.decorate('db', { pool: { connect: vi.fn() } })

  return { app, query }
}

describe('PATCH /v1/lives/:id/publicar — engine + validação marca', () => {
  it('retorna 422 quando live não tem marca', async () => {
    calcularMock.mockClear()
    const { app } = buildApp({
      liveRow: { id: liveId, status_publicacao: 'revisado', marca_id: null, ads_gmv: null, manual_gmv: 1000, fat_gerado: 1000 },
    })
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/publicar`,
      payload: { status_publicacao: 'publicado' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'MARCA_OBRIGATORIA_PUBLICAR' })
    expect(calcularMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('publica com marca + chama engine fire-and-forget', async () => {
    calcularMock.mockClear()
    calcularMock.mockResolvedValue([])
    const { app } = buildApp({
      liveRow: { id: liveId, status_publicacao: 'revisado', marca_id: marcaId, ads_gmv: 3000, manual_gmv: 2500, fat_gerado: 2000 },
    })
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/publicar`,
      payload: { status_publicacao: 'publicado' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: liveId, status_publicacao: 'publicado' })
    await vi.waitFor(() => {
      expect(calcularMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gmv: 3000 }))
    })
    await app.close()
  })

  it('422 quando transição inválida (rascunho → publicado direto)', async () => {
    calcularMock.mockClear()
    const { app } = buildApp({
      liveRow: { id: liveId, status_publicacao: 'rascunho', marca_id: marcaId, ads_gmv: null, manual_gmv: 100, fat_gerado: 100 },
    })
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/publicar`,
      payload: { status_publicacao: 'publicado' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.body).toContain('Transição inválida')
    await app.close()
  })
})
