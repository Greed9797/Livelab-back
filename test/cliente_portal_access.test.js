import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authPlugin } from '../src/plugins/auth.js'
import { relatoriosRoutes } from '../src/routes/relatorios.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const actor = '22222222-2222-4222-8222-222222222222'
const apps = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.unstubAllEnvs()
})

async function build({ guard = 'authenticate', papel = 'cliente_parceiro', state, unavailable = false, originalReport = false } = {}) {
  vi.stubEnv('JWT_SECRET', 'synthetic-local-client-portal-access-key-2026')
  const app = Fastify()
  apps.push(app)
  const current = { token_version: 1, ativo: true, papel, tenant_id: tenant }
  const query = vi.fn(async () => {
    if (unavailable) throw new Error('synthetic unavailable state')
    return { rows: state === null ? [] : [state ?? current] }
  })
  app.decorate('db', { query })
  const withTenant = vi.fn(async () => { throw new Error('legacy report handler must not execute') })
  app.decorate('withTenant', withTenant)
  await authPlugin(app)
  const handler = vi.fn(async () => ({ reached: true }))
  const preHandler = guard === 'role'
    ? app.requirePapel(['cliente_parceiro', 'gerente'])
    : guard === 'both'
      ? [app.authenticate, app.requirePapel(['cliente_parceiro', 'gerente'])]
      : app.authenticate
  const routes = [
    ['GET', '/v1/cliente/home'], ['GET', '/v1/cliente/conteudo/lives'],
    ['GET', '/v1/cliente/analytics/diario'], ['GET', '/v1/cliente/perfil'],
    ['GET', '/v1/cliente/meta'], ['POST', '/v1/auth/logout'], ['PATCH', '/v1/auth/senha'],
    ['GET', '/v1/cliente/financeiro'], ['GET', '/v1/cliente/operacional'],
    ['GET', '/v1/cliente/sessoes'], ['GET', '/v1/cliente/relatorio.pdf'],
    ['GET', '/v1/cliente/dashboard'], ['GET', '/v1/cliente/lives'],
    ['GET', '/v1/relatorios/cliente/:id/pdf'], ['GET', '/v1/apresentadoras'],
    ['GET', '/v1/configuracoes'], ['GET', '/v1/marcas'], ['GET', '/v1/internal-future'],
    ['GET', '/v1/cep/:cep'], ['GET', '/v1/apresentadoras/:id/faixas-comissao'],
    ['PATCH', '/v1/cliente/meta'], ['POST', '/v1/onboarding'],
    ['GET', '/v1/auth/senha'], ['POST', '/v1/cliente/home'],
  ]
  for (const [method, url] of routes) {
    if (originalReport && url === '/v1/relatorios/cliente/:id/pdf') continue
    app.route({ method, url, preHandler, handler })
  }
  if (originalReport) await app.register(relatoriosRoutes)
  app.get('/v1/cliente/fails', { preHandler }, async () => { throw new Error('synthetic') })
  const token = app.jwt.sign({ sub: actor, tenant_id: tenant, papel, token_version: 1 })
  return { app, handler, query, withTenant, headers: { authorization: `Bearer ${token}` } }
}

describe.each(['authenticate', 'role', 'both'])('cliente portal allowlist through %s', (guard) => {
  it.each([
    ['GET', '/v1/cliente/home?mes=10&ano=2026'], ['GET', '/v1/cliente/conteudo/lives?offset=50'],
    ['GET', '/v1/cliente/analytics/diario?from=2026-10-01&to=2026-10-31'],
    ['GET', '/v1/cliente/perfil'], ['GET', '/v1/cliente/meta'],
    ['POST', '/v1/auth/logout'], ['PATCH', '/v1/auth/senha'],
  ])('allows only the necessary %s %s with private responses', async (method, url) => {
    const { app, headers, handler } = await build({ guard })
    const response = await app.inject({ method, url, headers })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ reached: true })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(handler).toHaveBeenCalledOnce()
  })

  it.each([
    ['GET', '/v1/cliente/financeiro'], ['GET', '/v1/cliente/operacional'],
    ['GET', '/v1/cliente/sessoes'], ['GET', '/v1/cliente/relatorio.pdf'],
    ['GET', '/v1/cliente/dashboard'], ['GET', '/v1/cliente/lives'],
    ['GET', '/v1/relatorios/cliente/33333333-3333-4333-8333-333333333333/pdf'],
    ['GET', '/v1/apresentadoras'], ['GET', '/v1/configuracoes'], ['GET', '/v1/marcas'],
    ['GET', '/v1/internal-future'], ['PATCH', '/v1/cliente/meta'],
    ['GET', '/v1/cep/89000000'], ['GET', '/v1/apresentadoras/33333333-3333-4333-8333-333333333333/faixas-comissao'],
    ['POST', '/v1/onboarding'], ['GET', '/v1/auth/senha'], ['POST', '/v1/cliente/home'],
  ])('blocks %s %s before its handler', async (method, url) => {
    const { app, headers, handler } = await build({ guard })
    const response = await app.inject({ method, url, headers })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'Recurso indisponível no portal do cliente.' })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('cliente portal current sessions', () => {
  it('blocks the actual legacy PDF registration before resolving any customer report data', async () => {
    const { app, headers, withTenant, query } = await build({ originalReport: true })
    const response = await app.inject({ url: `/v1/relatorios/cliente/${actor}/pdf?periodo=2026-10`, headers })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'Recurso indisponível no portal do cliente.' })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(withTenant).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0]).toContain('SELECT token_version, ativo, papel, tenant_id FROM users')
  })
  it.each([
    ['missing', null],
    ['inactive', { token_version: 1, ativo: false, papel: 'cliente_parceiro', tenant_id: tenant }],
    ['revoked', { token_version: 2, ativo: true, papel: 'cliente_parceiro', tenant_id: tenant }],
    ['different tenant', { token_version: 1, ativo: true, papel: 'cliente_parceiro', tenant_id: actor }],
    ['different role', { token_version: 1, ativo: true, papel: 'gerente', tenant_id: tenant }],
  ])('denies a %s account on an allowed route', async (_name, state) => {
    const { app, headers, handler } = await build({ state })
    const response = await app.inject({ url: '/v1/cliente/home', headers })
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(handler).not.toHaveBeenCalled()
  })
  it('fails closed during account-state outage', async () => {
    const { app, headers, handler } = await build({ unavailable: true })
    const response = await app.inject({ url: '/v1/cliente/home', headers })
    expect(response.statusCode).toBe(503)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(handler).not.toHaveBeenCalled()
  })
  it('keeps expired sessions unauthorized even on a blocked route', async () => {
    const { app, headers, handler } = await build({ state: null })
    const response = await app.inject({ url: '/v1/internal-future', headers })
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(handler).not.toHaveBeenCalled()
  })
  it('does not grant access without a signed session', async () => {
    const { app, handler } = await build()
    const response = await app.inject('/v1/cliente/home')
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(handler).not.toHaveBeenCalled()
  })
  it('rejects a client token without account identity even on a blocked route', async () => {
    const { app, handler, query } = await build()
    const token = app.jwt.sign({ tenant_id: tenant, papel: 'cliente_parceiro' })
    const response = await app.inject({ url: '/v1/internal-future', headers: { authorization: `Bearer ${token}` } })
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(handler).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })
  it('does not restrict internal roles through the client allowlist', async () => {
    const { app, headers } = await build({ papel: 'gerente' })
    const response = await app.inject({ url: '/v1/internal-future', headers })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ reached: true })
  })
})
