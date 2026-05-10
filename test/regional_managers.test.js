import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

import { regionalManagersRoutes } from '../src/routes/regional_managers.js'

const MASTER_ID = '00000000-0000-0000-0000-000000000099'
const TARGET_USER = '11111111-1111-4111-8111-111111111111'
const TENANT_A = '22222222-2222-4222-8222-222222222222'
const TENANT_B = '33333333-3333-4333-8333-333333333333'

function buildApp({ papel = 'franqueador_master', queryImpl, poolClient } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (req) => {
    req.user = { tenant_id: 'tenant-master', papel, sub: MASTER_ID }
  })
  app.decorate('requirePapel', (papeis) => async (req, reply) => {
    if (!papeis.includes(req.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  const queryMock = queryImpl ?? vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  const defaultClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }
  app.decorate('db', {
    query: queryMock,
    pool: { connect: vi.fn().mockResolvedValue(poolClient ?? defaultClient) },
  })
  return { app, queryMock }
}

describe('GET /v1/master/regional-managers', () => {
  it('200 lista gerentes regionais (master)', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        { id: TARGET_USER, nome: 'Gerente A', email: 'a@x.com', ativo: true, created_at: new Date(), tenants: [{ id: TENANT_A, nome: 'T A' }] },
      ],
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(regionalManagersRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/master/regional-managers' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: TARGET_USER, tenants_count: 1 })
    await app.close()
  })

  it('403 quando papel não-master', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(regionalManagersRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/master/regional-managers' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('POST /v1/master/regional-managers/:userId/tenants', () => {
  it('200 quando substitui set transacionalmente', async () => {
    const clientQueries = []
    const client = {
      query: vi.fn(async (sql) => {
        clientQueries.push(sql)
        if (/SELECT id, papel FROM users/i.test(sql)) {
          return { rows: [{ id: TARGET_USER, papel: 'gerente_regional' }] }
        }
        if (/SELECT id FROM tenants/i.test(sql)) {
          return { rows: [{ id: TENANT_A }, { id: TENANT_B }] }
        }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const { app } = buildApp({ poolClient: client })
    await app.register(regionalManagersRoutes)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/master/regional-managers/${TARGET_USER}/tenants`,
      payload: { tenant_ids: [TENANT_A, TENANT_B] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, tenants_count: 2 })
    // BEGIN + DELETE + INSERT + COMMIT pattern
    expect(clientQueries.some((s) => /^BEGIN/.test(s))).toBe(true)
    expect(clientQueries.some((s) => /^COMMIT/.test(s))).toBe(true)
    expect(clientQueries.some((s) => /DELETE FROM user_tenant_access/.test(s))).toBe(true)
    expect(clientQueries.some((s) => /INSERT INTO user_tenant_access/.test(s))).toBe(true)
    await app.close()
  })

  it('404 quando user-alvo não existe', async () => {
    const client = {
      query: vi.fn(async (sql) => {
        if (/SELECT id, papel FROM users/i.test(sql)) return { rows: [] }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const { app } = buildApp({ poolClient: client })
    await app.register(regionalManagersRoutes)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/master/regional-managers/${TARGET_USER}/tenants`,
      payload: { tenant_ids: [TENANT_A] },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('400 quando user-alvo não é gerente_regional', async () => {
    const client = {
      query: vi.fn(async (sql) => {
        if (/SELECT id, papel FROM users/i.test(sql)) {
          return { rows: [{ id: TARGET_USER, papel: 'franqueado' }] }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const { app } = buildApp({ poolClient: client })
    await app.register(regionalManagersRoutes)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/master/regional-managers/${TARGET_USER}/tenants`,
      payload: { tenant_ids: [TENANT_A] },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('400 quando body inválido (tenant_ids não-uuid)', async () => {
    const { app } = buildApp()
    await app.register(regionalManagersRoutes)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/master/regional-managers/${TARGET_USER}/tenants`,
      payload: { tenant_ids: ['nao-uuid'] },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('403 quando papel não-master', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(regionalManagersRoutes)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/master/regional-managers/${TARGET_USER}/tenants`,
      payload: { tenant_ids: [TENANT_A] },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('DELETE /v1/master/regional-managers/:userId/tenants/:tenantId', () => {
  it('200 quando deleta acesso existente', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ id: 'x' }], rowCount: 1 })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(regionalManagersRoutes)
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/master/regional-managers/${TARGET_USER}/tenants/${TENANT_A}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    await app.close()
  })

  it('404 quando acesso não existe', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(regionalManagersRoutes)
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/master/regional-managers/${TARGET_USER}/tenants/${TENANT_A}`,
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
