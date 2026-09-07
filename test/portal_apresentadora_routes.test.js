import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { portalApresentadoraRoutes } from '../src/routes/portal_apresentadora.js'

const tenant = '11111111-1111-4111-8111-111111111111'

async function build({ papel = 'apresentadora', enabled = true } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => { request.user = { tenant_id: tenant, sub: '22222222-2222-4222-8222-222222222222', papel } })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'forbidden' })
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query: async () => ({ rows: [] }) }))
  const previous = process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST
  process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST = enabled ? tenant : ''
  await app.register(portalApresentadoraRoutes)
  return { app, restore: () => { process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST = previous } }
}

describe('portal apresentadora routes', () => {
  it.each(['apresentador', 'apresentadora'])('blocks %s from another live connector snapshot before querying data', async (papel) => {
    const { tiktokRoutes } = await import('../src/routes/tiktok.js')
    const app = Fastify()
    app.decorate('authenticate', async (request) => { request.user = { tenant_id: tenant, papel } })
    app.decorate('requirePapel', (roles) => async (request, reply) => {
      if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'forbidden' })
    })
    app.decorate('withTenant', async () => { throw new Error('Data access must not happen') })
    await app.register(tiktokRoutes)
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/lives/33333333-3333-4333-8333-333333333333/tiktok-status' })
      expect(response.statusCode).toBe(403)
    } finally { await app.close() }
  })

  it('keeps the pilot closed before touching profile/data', async () => {
    const { app, restore } = await build({ enabled: false })
    const response = await app.inject({ method: 'POST', url: '/v1/portal/apresentadora/submissoes', payload: {} })
    expect(response.statusCode).toBe(404)
    await app.close(); restore()
  })

  it('rejects manipulated/incomplete create payload before any write', async () => {
    const { app, restore } = await build()
    const response = await app.inject({ method: 'POST', url: '/v1/portal/apresentadora/submissoes', payload: { apresentadora_id: '33333333-3333-4333-8333-333333333333' } })
    expect(response.statusCode).toBe(400)
    await app.close(); restore()
  })

  it('does not let presenter use manager review routes', async () => {
    const { app, restore } = await build()
    const response = await app.inject({ method: 'POST', url: '/v1/lives/submissoes-apresentadoras/33333333-3333-4333-8333-333333333333/aprovar', payload: {} })
    expect(response.statusCode).toBe(403)
    await app.close(); restore()
  })

  it('fails closed when the dedicated portal executor is unavailable', async () => {
    const { app, restore } = await build()
    const response = await app.inject({ method: 'GET', url: '/v1/portal/apresentadora/me?mes=2026-09' })
    expect(response.statusCode).toBe(503)
    await app.close(); restore()
  })
})
