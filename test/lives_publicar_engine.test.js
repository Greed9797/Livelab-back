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

function buildApp({ liveRow, papel = 'franqueado', viaApiKey } = {}) {
  const app = Fastify()
  const release = vi.fn()
  const updates = []
  const query = vi.fn(async (sql) => {
    const s = String(sql)
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] }
    if (s.includes('SELECT id, status_publicacao, marca_id, ads_gmv, manual_gmv, fat_gerado, uniao_destino_id, uniao_desfeita_em FROM lives')) {
      return { rows: liveRow ? [liveRow] : [] }
    }
    if (s.includes('UPDATE lives SET status_publicacao')) {
      updates.push(s)
      return { rows: [{ id: liveId, status_publicacao: 'publicado' }] }
    }
    return { rows: [] }
  })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: viaApiKey ? null : 'user-1', papel }
    if (viaApiKey) request.viaApiKey = viaApiKey
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user?.papel)) {
      return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
    }
  })
  app.decorate('withTenant', async (_t, fn) => {
    try { return await fn({ query }) } finally { release() }
  })
  app.decorate('audit', { log: async () => {} })
  app.decorate('db', { pool: { connect: vi.fn() } })

  return { app, query, updates }
}

const chave = { id: 'key-1', nome: 'grok bot' }

async function publicar(app, body) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/lives/${liveId}/publicar`,
    payload: body,
  })
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

  it('a chave publica quando o gestor publicaria, sem reescrever origem_dados', async () => {
    calcularMock.mockClear()
    calcularMock.mockResolvedValue([])
    const { app, updates } = buildApp({
      papel: 'automacao',
      viaApiKey: chave,
      liveRow: {
        id: liveId,
        status_publicacao: 'revisado',
        marca_id: marcaId,
        origem_dados: 'manual',
        ads_gmv: 3000,
        manual_gmv: 2500,
        fat_gerado: 2000,
      },
    })
    await app.register(livesRoutes)

    const res = await publicar(app, { status_publicacao: 'publicado' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: liveId, status_publicacao: 'publicado' })
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatch(/SET status_publicacao/)
    expect(updates[0]).not.toMatch(/origem_dados/)
    await vi.waitFor(() => {
      expect(calcularMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gmv: 3000 }))
    })
    await app.close()
  })

  it('a chave recebe a mesma rejeição do gestor quando a publicação não é permitida', async () => {
    const casos = [
      {
        liveRow: { id: liveId, status_publicacao: 'rascunho', marca_id: marcaId, ads_gmv: null, manual_gmv: 100, fat_gerado: 100, origem_dados: 'manual' },
        body: { status_publicacao: 'publicado' },
        status: 422,
        trecho: 'Transição inválida',
      },
      {
        liveRow: { id: liveId, status_publicacao: 'revisado', marca_id: null, ads_gmv: null, manual_gmv: 1000, fat_gerado: 1000, origem_dados: 'manual' },
        body: { status_publicacao: 'publicado' },
        status: 422,
        trecho: 'MARCA_OBRIGATORIA_PUBLICAR',
      },
      {
        liveRow: { id: liveId, status_publicacao: 'revisado', marca_id: marcaId, uniao_destino_id: '44444444-4444-4444-8444-444444444444', ads_gmv: null, manual_gmv: 100, fat_gerado: 100, origem_dados: 'manual' },
        body: { status_publicacao: 'publicado' },
        status: 409,
        trecho: 'LIVE_UNIDA_IMUTAVEL',
      },
    ]

    for (const caso of casos) {
      const gestor = buildApp({ liveRow: caso.liveRow, papel: 'franqueado' })
      const bot = buildApp({ liveRow: caso.liveRow, papel: 'automacao', viaApiKey: chave })
      await gestor.app.register(livesRoutes)
      await bot.app.register(livesRoutes)

      const humano = await publicar(gestor.app, caso.body)
      const chaveRes = await publicar(bot.app, caso.body)

      expect(chaveRes.statusCode).toBe(caso.status)
      expect(chaveRes.statusCode).toBe(humano.statusCode)
      expect(chaveRes.json()).toEqual(humano.json())
      expect(chaveRes.body).toContain(caso.trecho)
      expect(gestor.updates).toEqual([])
      expect(bot.updates).toEqual([])
      await gestor.app.close()
      await bot.app.close()
    }
  })
})
