import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { usuariosRoutes } from '../src/routes/usuarios.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const actorId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'
const apresentadoraId = '44444444-4444-4444-8444-444444444444'

function buildApp({ queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: actorId, papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: actorId, papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
    }
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query }))

  return { app, query }
}

function baseInvitePayload() {
  return {
    nome: 'Jhemily',
    email: 'jhemily@example.com',
    papel: 'apresentador',
    fixo: 2700,
    comissao_pct: 1.5,
    meta_diaria_gmv: 10000,
    senha_temporaria: 'senha123',
  }
}

describe('usuarios presenter provisioning', () => {
  it('creates a presenter profile when inviting a presenter from settings', async () => {
    const queryMock = vi.fn(async (sql, values = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('SELECT id FROM users')) return { rows: [] }
      if (sql.includes('INSERT INTO users')) {
        return { rows: [{ id: userId, nome: values[1], email: values[2], papel: values[4], ativo: true, criado_em: '2026-05-22T00:00:00.000Z' }] }
      }
      if (sql.includes('INSERT INTO apresentadoras')) return { rows: [{ id: apresentadoraId }], rowCount: 1 }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(usuariosRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/usuarios/convidar',
      payload: baseInvitePayload(),
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      id: userId,
      apresentadora_id: apresentadoraId,
      pode_apresentar_live: true,
    })
    expect(query.mock.calls.some(([sql, values]) =>
      sql.includes('INSERT INTO apresentadoras') &&
      values[1] === userId &&
      values[2] === 'Jhemily' &&
      values[4] === 2700 &&
      values[5] === 1.5 &&
      values[6] === 10000
    )).toBe(true)

    await app.close()
  })

  it('links an existing unassigned presenter profile when selected in settings', async () => {
    const queryMock = vi.fn(async (sql, values = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('SELECT id FROM users')) return { rows: [] }
      if (sql.includes('INSERT INTO users')) {
        return { rows: [{ id: userId, nome: values[1], email: values[2], papel: values[4], ativo: true, criado_em: '2026-05-22T00:00:00.000Z' }] }
      }
      if (sql.includes('UPDATE apresentadoras')) return { rows: [{ id: apresentadoraId }], rowCount: 1 }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(usuariosRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/usuarios/convidar',
      payload: { ...baseInvitePayload(), apresentadora_id: apresentadoraId },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ apresentadora_id: apresentadoraId })
    expect(query.mock.calls.some(([sql, values]) =>
      sql.includes('UPDATE apresentadoras') &&
      values[0] === userId &&
      values[1] === apresentadoraId &&
      values[5] === 2700 &&
      values[6] === 1.5 &&
      values[7] === 10000
    )).toBe(true)

    await app.close()
  })

  it('provisions a presenter profile when patching a user into presenter role', async () => {
    const queryMock = vi.fn(async (sql, values = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: userId, nome: 'Yasmin', email: 'yasmin@example.com', papel: 'gerente' }] }
      }
      if (sql.includes('DELETE FROM refresh_tokens')) return { rows: [] }
      if (sql.includes('SELECT papel FROM users')) return { rows: [{ papel: 'gerente' }] }
      if (sql.includes('UPDATE users')) {
        return { rows: [{ id: userId, nome: values[0], email: 'yasmin@example.com', papel: values[1], ativo: true, criado_em: '2026-05-22T00:00:00.000Z' }] }
      }
      if (sql.includes('SELECT id FROM apresentadoras WHERE user_id')) return { rows: [] }
      if (sql.includes('INSERT INTO apresentadoras')) return { rows: [{ id: apresentadoraId }], rowCount: 1 }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(usuariosRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/usuarios/${userId}`,
      payload: {
        nome: 'Yasmin',
        papel: 'apresentadora',
        ativo: true,
        fixo: 2700,
        comissao_pct: 1.5,
        meta_diaria_gmv: 9000,
        foto_url: 'https://cdn.example.com/yasmin.jpg',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: userId,
      apresentadora_id: apresentadoraId,
      pode_apresentar_live: true,
    })
    expect(query.mock.calls.some(([sql, values]) =>
      sql.includes('INSERT INTO apresentadoras') &&
      values[1] === userId &&
      values[2] === 'Yasmin' &&
      values[4] === 2700 &&
      values[5] === 1.5 &&
      values[6] === 9000 &&
      values[7] === 'https://cdn.example.com/yasmin.jpg'
    )).toBe(true)

    await app.close()
  })

  it('updates an existing presenter profile when patching a presenter user', async () => {
    const queryMock = vi.fn(async (sql, values = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: userId, nome: 'Jady', email: 'jady@example.com', papel: 'apresentadora' }] }
      }
      if (sql.includes('DELETE FROM refresh_tokens')) return { rows: [] }
      if (sql.includes('SELECT papel FROM users')) return { rows: [{ papel: 'apresentadora' }] }
      if (sql.includes('UPDATE users')) {
        return { rows: [{ id: userId, nome: values[0], email: 'jady@example.com', papel: values[1], ativo: values[2], criado_em: '2026-05-22T00:00:00.000Z' }] }
      }
      if (sql.includes('SELECT id FROM apresentadoras WHERE user_id')) return { rows: [{ id: apresentadoraId }] }
      if (sql.includes('UPDATE apresentadoras')) return { rows: [{ id: apresentadoraId }], rowCount: 1 }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(usuariosRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/usuarios/${userId}`,
      payload: {
        nome: 'Jady',
        papel: 'apresentadora',
        ativo: true,
        fixo: 3000,
        comissao_pct: 2,
        meta_diaria_gmv: 12000,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ apresentadora_id: apresentadoraId, pode_apresentar_live: true })
    expect(query.mock.calls.some(([sql, values]) =>
      sql.includes('UPDATE apresentadoras') &&
      values[0] === 'Jady' &&
      values[4] === 3000 &&
      values[6] === 2 &&
      values[8] === 12000 &&
      values[11] === apresentadoraId
    )).toBe(true)

    await app.close()
  })
})
