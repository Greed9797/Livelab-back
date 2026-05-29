import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import crypto from 'node:crypto'

import { authRoutes } from '../src/routes/auth.js'

const TENANT = '00000000-0000-0000-0000-000000000001'
const USER_ID = '11111111-1111-1111-1111-111111111111'

function buildApp({ queryImpl } = {}) {
  const app = Fastify()
  const queryMock = queryImpl ?? vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  app.decorate('db', { query: queryMock, pool: null })
  // jwt mock pra aceitar-convite
  app.decorate('jwt', {
    sign: () => 'mocked-jwt-token',
  })
  app.decorate('authenticate', async (req) => {
    req.user = { sub: USER_ID, tenant_id: TENANT, papel: 'franqueado' }
  })
  return { app, queryMock }
}

let envSnap
beforeEach(() => { envSnap = process.env.NODE_ENV; process.env.NODE_ENV = 'test' })
afterEach(() => { if (envSnap !== undefined) process.env.NODE_ENV = envSnap; else delete process.env.NODE_ENV })

describe('POST /v1/auth/esqueci-senha (anti-enumeração)', () => {
  it('200 com mensagem genérica quando email não existe', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (/SELECT id, nome, email, tenant_id/i.test(sql)) return { rows: [] }
      return { rows: [], rowCount: 0 }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/esqueci-senha',
      payload: { email: 'nao-existe@x.com' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    expect(res.json().message).toMatch(/cadastrado/i)
  })

  it('200 quando email existe (resposta idêntica à do não existente)', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (/SELECT id, nome, email, tenant_id/i.test(sql)) {
        return {
          rows: [{ id: USER_ID, nome: 'João', email: 'j@x.com', tenant_id: TENANT }],
        }
      }
      if (/COUNT/i.test(sql)) return { rows: [{ n: 0 }] }
      return { rows: [], rowCount: 0 }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/esqueci-senha',
      payload: { email: 'j@x.com' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })

  it('200 mesmo com body inválido (anti-enum no formato)', async () => {
    const { app } = buildApp()
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/esqueci-senha',
      payload: { email: 'invalido' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /v1/auth/redefinir-senha', () => {
  it('400 quando token inválido (rowCount=0)', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/redefinir-senha',
      payload: {
        token: 'a'.repeat(64),
        nova_senha: 'Senha123abc',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/inválido|expirado/i)
  })

  it('400 quando senha fraca (sem letra ou número)', async () => {
    const { app } = buildApp()
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/redefinir-senha',
      payload: { token: 'a'.repeat(64), nova_senha: 'aaaaaaaa' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('200 quando token válido + revoga refresh tokens', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (/UPDATE password_reset_tokens/i.test(sql)) {
        return { rows: [{ user_id: USER_ID }], rowCount: 1 }
      }
      if (/UPDATE users/i.test(sql)) return { rows: [], rowCount: 1 }
      if (/UPDATE refresh_tokens/i.test(sql)) return { rows: [], rowCount: 3 }
      return { rows: [], rowCount: 0 }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/redefinir-senha',
      payload: { token: 'a'.repeat(64), nova_senha: 'Senha123abc' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    // Confirma que houve UPDATE em refresh_tokens (revoga sessões)
    const calls = queryMock.mock.calls.map((c) => c[0])
    expect(calls.some((sql) => /UPDATE refresh_tokens.*revogado/is.test(sql))).toBe(true)
  })
})

describe('POST /v1/auth/aceitar-convite', () => {
  it('400 quando token expirado/já usado (rowCount=0)', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/aceitar-convite',
      payload: { token: 'b'.repeat(64), nova_senha: 'Senha123abc' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/inválido|expirado/i)
  })

  it('200 com access+refresh+user quando convite válido', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (/UPDATE users/i.test(sql) && /invite_token_hash/i.test(sql)) {
        return {
          rows: [{
            id: USER_ID,
            tenant_id: TENANT,
            papel: 'franqueado',
            nome: 'Maria',
            email: 'm@x.com',
            onboarding_completed: false,
          }],
          rowCount: 1,
        }
      }
      if (/SELECT nome FROM tenants/i.test(sql)) {
        return { rows: [{ nome: 'Tenant 1' }] }
      }
      if (/INSERT INTO refresh_tokens/i.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/aceitar-convite',
      payload: { token: 'c'.repeat(64), nova_senha: 'Senha123abc' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.access_token).toBe('mocked-jwt-token')
    expect(body.refresh_token).toBeTruthy()
    expect(body.user).toMatchObject({
      id: USER_ID,
      tenant_id: TENANT,
      tenant_nome: 'Tenant 1',
      papel: 'franqueado',
    })
  })

  it('400 quando senha fraca', async () => {
    const { app } = buildApp()
    await app.register(authRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/aceitar-convite',
      payload: { token: 'd'.repeat(64), nova_senha: 'curta' },
    })
    expect(res.statusCode).toBe(400)
  })
})
