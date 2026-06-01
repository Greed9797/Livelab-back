import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { cabinesRoutes } from '../src/routes/cabines.js'

describe('GET /v1/cabines zombie live filter', () => {
  it('does not surface lives older than 24h as ao vivo', async () => {
    const app = Fastify()
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try {
        return await fn(db)
      } finally {
        db.release()
      }
    })

    await app.register(cabinesRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/cabines' })

    expect(response.statusCode).toBe(200)
    const sql = String(queryMock.mock.calls[0][0])
    expect(sql).toContain("l2.iniciado_em >= NOW() - INTERVAL '24 hours'")

    await app.close()
  })
})
