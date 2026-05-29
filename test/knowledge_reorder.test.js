import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

import { knowledgeRoutes } from '../src/routes/knowledge.js'

const TENANT = '00000000-0000-0000-0000-000000000001'
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

function buildApp({ papel = 'franqueador_master', poolClient } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (req) => {
    req.user = { tenant_id: TENANT, papel, sub: 'u1' }
  })
  app.decorate('requirePapel', (papeis) => async (req, reply) => {
    if (!req.user) req.user = { tenant_id: TENANT, papel, sub: 'u1' }
    if (!papeis.includes(req.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  const defaultClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }
  app.decorate('db', {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    pool: { connect: vi.fn().mockResolvedValue(poolClient ?? defaultClient) },
  })
  return { app }
}

describe('POST /v1/knowledge/categories/reorder', () => {
  it('204 quando master reordena (BEGIN/UPDATE/COMMIT)', async () => {
    const queries = []
    const client = {
      query: vi.fn(async (sql, params) => {
        queries.push({ sql, params })
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const { app } = buildApp({ poolClient: client })
    await app.register(knowledgeRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/categories/reorder',
      payload: { ids: [ID_A, ID_B, ID_C] },
    })
    expect(res.statusCode).toBe(204)
    expect(queries.some((q) => /^BEGIN/.test(q.sql))).toBe(true)
    expect(queries.some((q) => /^COMMIT/.test(q.sql))).toBe(true)
    // Confirma 3 UPDATEs com sort_order 1,2,3
    const updates = queries.filter((q) => /UPDATE knowledge_categories SET sort_order/.test(q.sql))
    expect(updates).toHaveLength(3)
    expect(updates[0].params).toEqual([1, ID_A])
    expect(updates[2].params).toEqual([3, ID_C])
    await app.close()
  })

  it('403 quando papel não-master', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(knowledgeRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/categories/reorder',
      payload: { ids: [ID_A, ID_B] },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('400 quando ids vazio', async () => {
    const { app } = buildApp()
    await app.register(knowledgeRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/categories/reorder',
      payload: { ids: [] },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('400 quando id não é UUID', async () => {
    const { app } = buildApp()
    await app.register(knowledgeRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/categories/reorder',
      payload: { ids: ['nao-uuid'] },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
