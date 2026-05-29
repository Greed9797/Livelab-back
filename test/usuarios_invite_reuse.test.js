// Regressão: POST /v1/usuarios/convidar deve permitir reuso de email
// previamente soft-deletado (users.ativo=false). Antes do fix bloqueava com
// 409 "E-mail já cadastrado", surpresa porque o GET filtra inativos.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { usuariosRoutes } from '../src/routes/usuarios.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const actorId = '22222222-2222-4222-8222-222222222222'
const newUserId = '33333333-3333-4333-8333-333333333333'

function buildApp({ queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: actorId, papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: actorId, papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))

  return { app, query }
}

const payload = {
  nome: 'Vendedora Nova',
  email: 'reuso@example.com',
  papel: 'apresentadora',
  fixo: 0,
  comissao_pct: 0,
  meta_diaria_gmv: 0,
  senha_temporaria: 'senha123',
}

describe('POST /v1/usuarios/convidar — reuso de email após soft-delete', () => {
  it('SELECT existing usa AND ativo IS NOT FALSE', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('SELECT id FROM users')) return { rows: [] }
      if (sql.includes('INSERT INTO users')) {
        return { rows: [{ id: newUserId, nome: 'Vendedora Nova', email: 'reuso@example.com', papel: 'apresentadora', ativo: true, criado_em: '2026-05-26T00:00:00.000Z' }] }
      }
      if (sql.includes('INSERT INTO apresentadoras')) return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(usuariosRoutes)

    const res = await app.inject({ method: 'POST', url: '/v1/usuarios/convidar', payload })
    expect(res.statusCode).toBe(201)

    const selectCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('SELECT id FROM users')
    )
    expect(selectCall).toBeTruthy()
    expect(String(selectCall[0])).toContain('ativo IS NOT FALSE')

    await app.close()
  })

  it('retorna 409 com code EMAIL_ALREADY_ACTIVE quando email ativo já existe', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT id FROM users')) {
        return { rows: [{ id: 'existing-user-id' }] }
      }
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock })
    await app.register(usuariosRoutes)

    const res = await app.inject({ method: 'POST', url: '/v1/usuarios/convidar', payload })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'EMAIL_ALREADY_ACTIVE' })

    await app.close()
  })

  it('permite cadastrar quando email só existe inativo (SELECT retorna vazio)', async () => {
    // Mock simula: índice parcial + filtro AND ativo IS NOT FALSE escondem inativos.
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('SELECT id FROM users')) return { rows: [] }
      if (sql.includes('INSERT INTO users')) {
        return { rows: [{ id: newUserId, nome: 'X', email: 'reuso@example.com', papel: 'apresentadora', ativo: true, criado_em: '2026-05-26T00:00:00.000Z' }] }
      }
      if (sql.includes('INSERT INTO apresentadoras')) return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 }
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock })
    await app.register(usuariosRoutes)

    const res = await app.inject({ method: 'POST', url: '/v1/usuarios/convidar', payload })
    expect(res.statusCode).toBe(201)

    await app.close()
  })
})
