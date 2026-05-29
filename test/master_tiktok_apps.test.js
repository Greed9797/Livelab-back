import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

import { tenantsRoutes } from '../src/routes/tenants.js'

const MASTER_TENANT = '00000000-0000-0000-0000-000000000099'
const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const TENANT_C = '33333333-3333-4333-8333-333333333333'

function buildApp({ papel = 'franqueador_master', queryImpl } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (req) => {
    req.user = { tenant_id: MASTER_TENANT, papel, sub: 'user-master' }
  })
  app.decorate('requirePapel', (papeis) => async (req, reply) => {
    if (!papeis.includes(req.user.papel)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
  })
  const queryMock = queryImpl ?? vi.fn().mockResolvedValue({ rows: [] })
  app.decorate('db', {
    query: queryMock,
    pool: { connect: vi.fn() },
  })
  return { app, queryMock }
}

describe('GET /v1/master/tiktok-apps', () => {
  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const pastExpiry = new Date(Date.now() - 1 * 60 * 60 * 1000)

  function buildRows() {
    return {
      rows: [
        {
          tenant_id: TENANT_A,
          tenant_nome: 'Unidade A',
          cidade: 'São Paulo',
          uf: 'SP',
          ativo: true,
          shop_id: 'open_id_a***',
          expires_at: futureExpiry,
          has_token: true,
        },
        {
          tenant_id: TENANT_B,
          tenant_nome: 'Unidade B',
          cidade: 'Rio',
          uf: 'RJ',
          ativo: true,
          shop_id: null,
          expires_at: null,
          has_token: false,
        },
        {
          tenant_id: TENANT_C,
          tenant_nome: 'Unidade C',
          cidade: 'BH',
          uf: 'MG',
          ativo: true,
          shop_id: 'open_id_c***',
          expires_at: pastExpiry,
          has_token: true,
        },
      ],
    }
  }

  it('200 retorna apps multi-tenant com status calculado', async () => {
    const queryMock = vi.fn().mockResolvedValue(buildRows())
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(tenantsRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/master/tiktok-apps' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(3)
    const a = body.find((x) => x.tenant_id === TENANT_A)
    const b = body.find((x) => x.tenant_id === TENANT_B)
    const c = body.find((x) => x.tenant_id === TENANT_C)
    expect(a.status).toBe('connected')
    expect(a.connected).toBe(true)
    expect(b.status).toBe('disconnected')
    expect(b.connected).toBe(false)
    expect(c.status).toBe('expired')
    expect(c.connected).toBe(false)
    // garante que tokens não vazam na resposta
    expect(a.access_token).toBeUndefined()
    expect(a.refresh_token).toBeUndefined()
    await app.close()
  })

  it('filtra por status=connected', async () => {
    const queryMock = vi.fn().mockResolvedValue(buildRows())
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(tenantsRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/master/tiktok-apps?status=connected',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].tenant_id).toBe(TENANT_A)
    await app.close()
  })

  it('403 quando papel não é franqueador_master', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(tenantsRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/master/tiktok-apps' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
