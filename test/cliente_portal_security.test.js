import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { clientePortalRoutes } from '../src/routes/cliente_portal.js'

function buildApp({ sysQuery, tenantQuery }) {
  const app = Fastify()
  const sysRelease = vi.fn()
  const tenantRelease = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { sub: 'user-1', tenant_id: '11111111-1111-4111-8111-111111111111', papel: 'cliente_parceiro' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('db', {
    pool: {
      connect: vi.fn().mockResolvedValue({ query: sysQuery, release: sysRelease }),
    },
  })
  app.decorate('dbTenant', async () => ({ query: tenantQuery, release: tenantRelease }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return { app, sysRelease, tenantRelease }
}

describe('cliente portal security', () => {
  it('blocks cliente agenda before resolving tenant data during go-live scope', async () => {
    const sysQuery = vi.fn()
    const tenantQuery = vi.fn()
    const { app } = buildApp({ sysQuery, tenantQuery })

    await app.register(clientePortalRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cliente/agenda?data_inicio=2026-05-01&data_fim=2026-05-07',
    })

    expect(response.statusCode).toBe(403)
    expect(sysQuery).not.toHaveBeenCalled()
    expect(tenantQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('blocks cliente solicitacao before validating or touching DB during go-live scope', async () => {
    const sysQuery = vi.fn()
    const tenantQuery = vi.fn()
    const { app } = buildApp({ sysQuery, tenantQuery })

    await app.register(clientePortalRoutes)

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/cliente/solicitacao',
      payload: {
        cabine_id: '33333333-3333-4333-8333-333333333333',
        data_solicitada: '2026-06-10',
        hora_inicio: '8h',
        hora_fim: '10:00',
      },
    })
    const inverted = await app.inject({
      method: 'POST',
      url: '/v1/cliente/solicitacao',
      payload: {
        cabine_id: '33333333-3333-4333-8333-333333333333',
        data_solicitada: '2026-06-10',
        hora_inicio: '12:00',
        hora_fim: '10:00',
      },
    })

    expect(invalid.statusCode).toBe(403)
    expect(inverted.statusCode).toBe(403)
    expect(sysQuery).not.toHaveBeenCalled()
    expect(tenantQuery).not.toHaveBeenCalled()

    await app.close()
  })
})
