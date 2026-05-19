import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { apresentadorasRoutes } from '../src/routes/apresentadoras.js'

function buildApp({ papel = 'franqueado', queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
    }
  })
  app.decorate('withTenant', async (_tenantId, fn) => {
    try { return await fn({ query }) } finally { release() }
  })

  return { app, query, release }
}

describe('apresentadoras permissions', () => {
  it('allows franqueado to edit presenter profiles', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{
        id: 'ap-1',
        nome: 'Edja',
        ativo: true,
      }],
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/apresentadoras/ap-1',
      payload: { nome: 'Edja Live' },
    })

    expect(response.statusCode).toBe(200)
    expect(query.mock.calls[0][0]).toContain('UPDATE apresentadoras')

    await app.close()
  })

  it('allows franqueado to delete presenter profiles as soft delete', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ id: 'ap-1' }] })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/apresentadoras/ap-1',
    })

    expect(response.statusCode).toBe(204)
    expect(query.mock.calls[0][0]).toContain('UPDATE apresentadoras SET ativo = false')

    await app.close()
  })
})
