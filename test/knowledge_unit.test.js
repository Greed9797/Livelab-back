import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { knowledgeUnitRoutes } from '../src/routes/knowledge-unit.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const MATERIAL = '33333333-3333-4333-8333-333333333333'

function buildApp({ papel = 'franqueado', tenant = TENANT, queryResults = [] } = {}) {
  const app = Fastify()
  const queries = []
  app.decorate('authenticate', async (request) => { request.user = { sub: 'user-1', tenant_id: tenant, papel } })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user?.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  const query = vi.fn(async (sql, params) => {
    queries.push({ sql, params })
    return queryResults.shift() ?? { rows: [] }
  })
  app.decorate('db', { query, pool: { connect: vi.fn() } })
  app.decorate('withTenant', async (id, fn) => fn({ query: async (sql, params) => query(sql, [id, ...(params ?? []).filter((value) => value !== id)]) }))
  return { app, query, queries }
}

describe('local knowledge base security and editing', () => {
  it('rejects client and automation roles before touching the database', async () => {
    for (const papel of ['cliente_parceiro', 'automacao']) {
      const { app, query } = buildApp({ papel })
      await app.register(knowledgeUnitRoutes)
      const response = await app.inject({ method: 'GET', url: '/v1/knowledge/unit/materials' })
      expect(response.statusCode).toBe(403)
      expect(query).not.toHaveBeenCalled()
      await app.close()
    }
  })

  it('lists with tenant predicate, published status and bounded pagination', async () => {
    const { app, query, queries } = buildApp({ queryResults: [{ rows: [{ id: MATERIAL }] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/knowledge/unit/materials?page=2&page_size=24&q=playbook' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ items: [{ id: MATERIAL }], page: 2, page_size: 24 })
    expect(queries[0].sql).toMatch(/m\.tenant_id = \$1/)
    expect(queries[0].sql).toMatch(/m\.status = 'published'/)
    expect(queries[0].params).toContain(TENANT)
    expect(queries[0].params).toContain(24)
    expect(queries[0].params).toContain(24)
    await app.close()
  })

  it('requires expected revision and returns conflict when the row was changed', async () => {
    const { app, query } = buildApp({ queryResults: [{ rows: [] }, { rows: [{ id: MATERIAL, revision: 4 }] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'PATCH', url: `/v1/knowledge/unit/materials/${MATERIAL}`, payload: { titulo: 'Nova versão', expected_revision: 3 } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ current_revision: 4 })
    expect(query).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it('rejects active HTML and unsafe video URLs', async () => {
    const { app, query } = buildApp()
    await app.register(knowledgeUnitRoutes)
    const html = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', payload: { titulo: 'X', content_markdown: '<script>alert(1)</script>' } })
    const url = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', payload: { titulo: 'X', content_markdown: 'texto', video_provider: 'youtube', video_url: 'https://evil.example/video' } })
    expect(html.statusCode).toBe(400)
    expect(url.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('does not return a material from another tenant even when its id is known', async () => {
    const { app, query } = buildApp({ tenant: OTHER_TENANT, queryResults: [{ rows: [] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'GET', url: `/v1/knowledge/unit/materials/${MATERIAL}` })
    expect(response.statusCode).toBe(404)
    expect(query.mock.calls[0][1]).toContain(OTHER_TENANT)
    await app.close()
  })
})
