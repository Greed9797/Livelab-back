import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientePortalRoutes } from '../src/routes/cliente_portal.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const user = '22222222-2222-4222-8222-222222222222'
const cliente = '33333333-3333-4333-8333-333333333333'
const marca = '44444444-4444-4444-8444-444444444444'
const apps = []
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

async function build({ clients = [{ id: cliente, nome: 'Marca própria', status: 'ativo' }], brands = [{ id: marca, nome: 'Marca própria' }], meta = [{ meta_gmv: '1500' }], fail = false } = {}) {
  const app = Fastify()
  apps.push(app)
  const query = vi.fn(async (sql) => {
    if (fail) throw new Error('synthetic query unavailable')
    if (/FROM clientes/.test(sql) && !/\bemail\b/.test(sql)) return { rows: clients }
    if (/FROM marcas/.test(sql)) return { rows: brands }
    if (/FROM cliente_metas/.test(sql)) return { rows: meta }
    return { rows: [{ id: cliente, nome: 'Marca própria', email: 'responsavel@example.test', fat_anual: '999999', apresentadora_nome: 'NÃO EXPOR' }] }
  })
  app.decorate('authenticate', async (request) => { request.user = { sub: user, tenant_id: tenant, papel: 'cliente_parceiro' } })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (tid, fn) => { expect(tid).toBe(tenant); return fn({ query }) })
  await app.register(clientePortalRoutes)
  return { app, query }
}

describe('own client profile and target', () => {
  it('only returns explicit own profile fields after resolving its exact brand', async () => {
    const { app, query } = await build()
    const response = await app.inject('/v1/cliente/perfil?cliente_id=outro&marca_id=outra')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: cliente, nome: 'Marca própria', email: 'responsavel@example.test', celular: null, cnpj: null, razao_social: null, site: null, logo_url: null, nicho: null, cidade: null, estado: null, tiktok_username: null })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(query.mock.calls[0][1]).toEqual([user, tenant])
    expect(query.mock.calls[1][1]).toEqual([tenant, cliente])
    expect(query.mock.calls[2][1]).toEqual([cliente, user, tenant])
  })
  it.each([
    ['missing client', { clients: [] }],
    ['ambiguous client', { clients: [{ id: cliente }, { id: marca }] }],
    ['missing brand', { brands: [] }],
    ['ambiguous brand', { brands: [{ id: marca }, { id: user }] }],
  ])('denies %s for both profile and target', async (_name, options) => {
    const { app, query } = await build(options)
    for (const url of ['/v1/cliente/perfil', '/v1/cliente/meta?mes=10&ano=2026']) {
      query.mockClear()
      const response = await app.inject(url)
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: 'Vínculo de cliente e marca não configurado.' })
      expect(response.headers['cache-control']).toBe('private, no-store')
      expect(query.mock.calls.some(([sql]) => /FROM cliente_metas/.test(sql))).toBe(false)
    }
  })
  it('uses explicit tenant and own client for target values, preserving actual zero', async () => {
    const { app, query } = await build({ meta: [{ meta_gmv: '0' }] })
    const response = await app.inject('/v1/cliente/meta?mes=10&ano=2026&cliente_id=outro')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ano: 2026, mes: 10, meta_gmv: 0 })
    expect(query.mock.calls.at(-1)[0]).toContain('tenant_id = $2::uuid')
    expect(query.mock.calls.at(-1)[1]).toEqual([cliente, tenant, 2026, 10])
  })
  it('keeps an unconfigured target unknown', async () => {
    const { app } = await build({ meta: [] })
    expect((await app.inject('/v1/cliente/meta?mes=10&ano=2026')).json()).toEqual({ ano: 2026, mes: 10, meta_gmv: null })
  })
  it.each(['mes=10junk&ano=2026', 'mes=10&ano=2026junk', 'mes=13&ano=2026', 'mes=10&ano=9999'])('rejects malformed target period %s', async (params) => {
    const { app, query } = await build()
    const response = await app.inject(`/v1/cliente/meta?${params}`)
    expect(response.statusCode).toBe(400)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(query).not.toHaveBeenCalled()
  })
  it('keeps error responses private during query failure', async () => {
    const { app } = await build({ fail: true })
    const response = await app.inject('/v1/cliente/perfil')
    expect(response.statusCode).toBe(500)
    expect(response.headers['cache-control']).toBe('private, no-store')
  })
})
