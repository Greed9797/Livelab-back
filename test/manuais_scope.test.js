import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { manuaisRoutes } from '../src/routes/manuais.js'

function buildApp(papel) {
  const app = Fastify()
  const query = vi.fn().mockResolvedValue({ rows: [] })
  app.decorate('authenticate', async (request) => { request.user = { papel, tenant_id: '11111111-1111-4111-8111-111111111111' } })
  app.decorate('requirePapel', (roles) => async (request, reply) => roles.includes(request.user.papel) || reply.code(403).send({ error: 'Forbidden' }))
  app.decorate('db', { query })
  return { app, query }
}

describe('legacy global manuals scope', () => {
  it('local management sees only published global manuals', async () => {
    const { app, query } = buildApp('franqueado')
    await app.register(manuaisRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/manuais' })
    expect(response.statusCode).toBe(200)
    expect(query.mock.calls[0][1]).toEqual([false])
    expect(query.mock.calls[0][0]).toMatch(/WHERE \$1 OR status = 'published'/)
    await app.close()
  })

  it('only master can see global drafts and archived manuals', async () => {
    const { app, query } = buildApp('franqueador_master')
    await app.register(manuaisRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/manuais' })
    expect(response.statusCode).toBe(200)
    expect(query.mock.calls[0][1]).toEqual([true])
    await app.close()
  })

  it('rejects client partners before querying legacy manuals', async () => {
    const { app, query } = buildApp('cliente_parceiro')
    await app.register(manuaisRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/manuais' })
    expect(response.statusCode).toBe(403)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })
})
