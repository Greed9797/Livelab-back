import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { boletosRoutes } from '../src/routes/boletos.js'

function buildApp({ papel = 'cliente_parceiro', queryMock } = {}) {
  const app = Fastify()
  const _query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: _query, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })
  return { app, queryMock: _query, release }
}

describe('boletos cliente_parceiro scoping', () => {
  it('filters boleto list by clientes.user_id linkage', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'cliente-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'boleto-1', valor: '100' }] })
    const { app } = buildApp({ queryMock })
    await app.register(boletosRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/boletos' })

    expect(res.statusCode).toBe(200)
    expect(queryMock.mock.calls[0][0]).toContain('user_id = $1')
    expect(queryMock.mock.calls[1][0]).toContain('cliente_id = $2')
    expect(queryMock.mock.calls[1][1]).toEqual(['tenant-1', 'cliente-1'])
    await app.close()
  })

  it('does not add cliente filter for admin boleto list', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce({ rows: [] })
    const { app } = buildApp({ papel: 'franqueado', queryMock })
    await app.register(boletosRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/boletos' })

    expect(res.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0][0]).not.toContain('cliente_id = $2')
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-1'])
    await app.close()
  })
})
