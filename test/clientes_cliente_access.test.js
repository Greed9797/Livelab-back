import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { clientesRoutes } from '../src/routes/clientes.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const actorId = '22222222-2222-4222-8222-222222222222'
const clienteId = '33333333-3333-4333-8333-333333333333'
const userId = '44444444-4444-4444-8444-444444444444'

function buildApp({ queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: actorId, papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: actorId, papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query }))
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })

  return { app, query }
}

function clientePayload(overrides = {}) {
  return {
    nome: 'Cliente Teste',
    celular: '47999999999',
    email: 'cliente@example.com',
    fat_anual: 0,
    criar_acesso: true,
    acesso_nome: 'Cliente Teste',
    senha_temporaria: 'senha123',
    ...overrides,
  }
}

describe('clientes access provisioning', () => {
  it('creates cliente and cliente_parceiro access atomically for franqueado', async () => {
    const queryMock = vi.fn(async (sql, values = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (String(sql).includes('INSERT INTO clientes')) {
        return { rows: [{ id: clienteId, tenant_id: tenantId, nome: values[1], email: values[6], user_id: null }] }
      }
      if (String(sql).includes('SELECT id FROM users')) return { rows: [] }
      if (String(sql).includes('INSERT INTO users')) {
        return {
          rows: [{
            id: userId,
            nome: values[1],
            email: values[2],
            papel: 'cliente_parceiro',
            ativo: true,
            criado_em: '2026-06-01T00:00:00.000Z',
          }],
        }
      }
      if (String(sql).includes('UPDATE clientes') && String(sql).includes('SET user_id')) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/clientes', payload: clientePayload() })

    expect(response.statusCode).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({
      id: clienteId,
      user_id: userId,
      acesso_email: 'cliente@example.com',
      acesso_ativo: true,
      acesso: {
        user_id: userId,
        email: 'cliente@example.com',
        ativo: true,
        senha_temporaria: 'senha123',
      },
    })
    expect(query.mock.calls.some(([sql, values]) =>
      String(sql).includes('INSERT INTO users') &&
      values[0] === tenantId &&
      values[2] === 'cliente@example.com' &&
      values[4] === actorId
    )).toBe(true)
    expect(query.mock.calls.some(([sql, values]) =>
      String(sql).includes('UPDATE clientes') &&
      String(sql).includes('SET user_id') &&
      values[0] === userId &&
      values[1] === clienteId &&
      values[2] === tenantId
    )).toBe(true)

    await app.close()
  })

  it('rolls back cliente creation when access email already exists in tenant', async () => {
    const queryMock = vi.fn(async (sql, values = []) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (String(sql).includes('INSERT INTO clientes')) {
        return { rows: [{ id: clienteId, tenant_id: tenantId, nome: values[1], email: values[6] }] }
      }
      if (String(sql).includes('SELECT id FROM users')) return { rows: [{ id: 'existing-user' }] }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/clientes', payload: clientePayload() })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'EMAIL_ALREADY_ACTIVE' })
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO users'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)

    await app.close()
  })

  it('returns access linkage fields in clientes list', async () => {
    const queryMock = vi.fn(async (sql) => {
      expect(String(sql)).toContain('cl.user_id')
      expect(String(sql)).toContain('u.email AS acesso_email')
      expect(String(sql)).toContain("u.papel = 'cliente_parceiro'")
      return { rows: [{ id: clienteId, nome: 'Cliente Teste', user_id: userId, acesso_email: 'cliente@example.com', acesso_ativo: true }] }
    })
    const { app } = buildApp({ queryMock })
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/clientes' })

    expect(response.statusCode).toBe(200)
    expect(response.json()[0]).toMatchObject({ user_id: userId, acesso_email: 'cliente@example.com', acesso_ativo: true })

    await app.close()
  })
})
