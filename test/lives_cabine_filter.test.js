import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { livesRoutes } from '../src/routes/lives.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const cabine = '22222222-2222-4222-8222-222222222222'
const liveId = '33333333-3333-4333-8333-333333333333'

async function setup() {
  const app = Fastify()
  const query = vi.fn(async (sql) => ({ rows: String(sql).includes('COUNT(*) OVER()')
    ? [{ id: liveId, total_count: 12 }]
    : String(sql).includes('WHERE l.id = ANY') ? [{ id: liveId, cabine_id: cabine }] : [] }))
  app.decorate('authenticate', async (req) => { req.user = { tenant_id: tenant, sub: 'operator', papel: 'franqueado' } })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })
  app.decorate('cache', { invalidate: async () => {}, get: async () => null, set: async () => {} })
  await app.register(livesRoutes)
  return { app, query }
}

describe('lista de lives por cabine', () => {
  it('filtra os IDs antes da paginação e da contagem, mantendo o tenant', async () => {
    const { app, query } = await setup()
    try {
      const response = await app.inject(`/v1/lives?paginado=1&cabine_id=${cabine}&data_inicio=2026-09-01&data_fim=2026-09-05&page=1&limit=10`)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ items: [{ id: liveId, cabine_id: cabine }], total: 12, page: 1, limit: 10 })
      const [sql, params] = query.mock.calls[0]
      expect(params).toEqual([tenant, cabine, '2026-09-01', '2026-09-05'])
      expect(sql).toContain('WHERE l.tenant_id = $1::uuid AND l.cabine_id = $2::uuid')
      expect(sql).toContain('LIMIT 10 OFFSET 10')
      expect(query.mock.calls[1][1]).toEqual([[liveId], tenant])
    } finally { await app.close() }
  })

  it('recusa UUID inválido em vez de devolver outras cabines silenciosamente', async () => {
    const { app, query } = await setup()
    try {
      const response = await app.inject('/v1/lives?cabine_id=nao-e-uuid')
      expect(response.statusCode).toBe(400)
      expect(query).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('preserva o shape legado sem filtro e sem paginação', async () => {
    const { app, query } = await setup()
    try {
      const response = await app.inject('/v1/lives')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual([])
      expect(query.mock.calls[0][1]).toEqual([tenant])
      expect(query.mock.calls[0][0]).not.toContain('AND l.cabine_id =')
    } finally { await app.close() }
  })
})
