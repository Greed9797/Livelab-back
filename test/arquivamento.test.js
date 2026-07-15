// Arquivamento: listagens default ocultam arquivados; params listam.
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { marcasRoutes } from '../src/routes/marcas.js'
import { apresentadorasRoutes } from '../src/routes/apresentadoras.js'

const tenantId = '11111111-1111-4111-8111-111111111111'

function build(routes) {
  const app = Fastify()
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  app.decorate('authenticate', async (req) => { req.user = { tenant_id: tenantId, papel: 'franqueado' } })
  app.decorate('requirePapel', () => async (req) => { if (!req.user) req.user = { tenant_id: tenantId, papel: 'franqueado' } })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.register(routes)
  return { app, query }
}

describe('GET /v1/marcas — arquivadas', () => {
  it('default exclui inativa E arquivada', async () => {
    const { app, query } = build(marcasRoutes)
    await app.ready()
    await app.inject({ method: 'GET', url: '/v1/marcas' })
    const sql = query.mock.calls.map(([s]) => String(s)).find((s) => s.includes('FROM marcas'))
    expect(sql).toContain("NOT IN ('inativa', 'arquivada')")
    await app.close()
  })

  it('?status=arquivada filtra exato', async () => {
    const { app, query } = build(marcasRoutes)
    await app.ready()
    await app.inject({ method: 'GET', url: '/v1/marcas?status=arquivada' })
    const call = query.mock.calls.find(([s]) => String(s).includes('FROM marcas'))
    expect(call[1]).toContain('arquivada')
    await app.close()
  })

  it('PATCH aceita status=arquivada (não 400)', async () => {
    const { app } = build(marcasRoutes)
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/marcas/00000000-0000-4000-8000-000000000001',
      payload: { status: 'arquivada' },
    })
    // Passou do parse Zod: não pode ser 400 de validação do enum
    expect(res.statusCode).not.toBe(400)
    await app.close()
  })
})

describe('GET /v1/apresentadoras — arquivadas', () => {
  it('default exclui arquivada=true; include_archived bypassa', async () => {
    const { app, query } = build(apresentadorasRoutes)
    await app.ready()
    await app.inject({ method: 'GET', url: '/v1/apresentadoras' })
    const def = query.mock.calls.map(([s]) => String(s)).find((s) => s.includes('FROM apresentadoras'))
    expect(def).toContain('a.arquivada IS NOT TRUE')

    query.mockClear()
    await app.inject({ method: 'GET', url: '/v1/apresentadoras?include_archived=true' })
    const inc = query.mock.calls.map(([s]) => String(s)).find((s) => s.includes('FROM apresentadoras'))
    expect(inc).not.toContain('a.arquivada IS NOT TRUE')
    await app.close()
  })
})
