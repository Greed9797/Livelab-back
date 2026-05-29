// Testes da mecânica de revogação imediata de JWT via token_version (F4 hardening).
//
// Garante que:
//   1) /v1/auth/redefinir-senha incrementa users.token_version.
//   2) Um JWT antigo (token_version stale) é rejeitado por app.authenticate
//      mesmo dentro do TTL de 15min.

import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { authPlugin } from '../src/plugins/auth.js'
import { authRoutes } from '../src/routes/auth.js'

// Helper: registra um stub do plugin "db" (mesmo nome que o plugin real),
// satisfazendo a dependência declarada por authPlugin.
function registerDbStub(app, query) {
  return app.register(
    fp(
      async (instance) => {
        instance.decorate('db', { query, pool: { connect: vi.fn() } })
      },
      { name: 'db' }
    )
  )
}

const ENV_KEYS = ['JWT_SECRET', 'NODE_ENV']
let envSnapshot = {}

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? 'test-secret-min-32-chars-aaaaaaaaaaaa'
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k]
    else process.env[k] = envSnapshot[k]
  }
})

describe('token_version: revogação imediata de JWT', () => {
  it('redefinir-senha INCREMENTA users.token_version no UPDATE', async () => {
    const queryMock = vi.fn().mockImplementation((sql) => {
      // 1ª query: consumo atômico do token de reset → retorna user_id
      if (/UPDATE password_reset_tokens/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ user_id: 'user-42' }] })
      }
      // 2ª query: UPDATE users — assertamos o conteúdo abaixo
      if (/UPDATE users/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [] })
      }
      // 3ª query: revoga refresh_tokens
      if (/UPDATE refresh_tokens/i.test(sql)) {
        return Promise.resolve({ rowCount: 0, rows: [] })
      }
      return Promise.resolve({ rowCount: 0, rows: [] })
    })

    const app = Fastify()
    await registerDbStub(app, queryMock)
    await app.register(authPlugin)
    await app.register(authRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/redefinir-senha',
      payload: {
        token: 'a'.repeat(64),
        nova_senha: 'NovaSenha@123',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })

    // Verifica que o UPDATE users contém `token_version = token_version + 1`
    const usersUpdate = queryMock.mock.calls.find((c) => /UPDATE users/i.test(c[0]))
    expect(usersUpdate).toBeDefined()
    expect(usersUpdate[0]).toMatch(/token_version\s*=\s*token_version\s*\+\s*1/i)

    await app.close()
  })

  it('app.authenticate rejeita JWT cujo token_version < DB.token_version', async () => {
    // Mock db: user-42 tem token_version=2, mas o JWT vai carregar token_version=1.
    const dbQuery = vi.fn().mockImplementation((sql, params) => {
      if (/SELECT token_version FROM users/i.test(sql)) {
        expect(params).toEqual(['user-42'])
        return Promise.resolve({ rows: [{ token_version: 2 }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const app = Fastify()
    await registerDbStub(app, dbQuery)
    await app.register(authPlugin)

    // Rota protegida
    app.get('/protegida', { preHandler: app.authenticate }, async () => ({ ok: true }))

    // Emite JWT com token_version stale (1)
    const staleJwt = app.jwt.sign({
      sub: 'user-42',
      tenant_id: 'tenant-1',
      papel: 'franqueado',
      nome: 'Stale',
      email: 'stale@x.com',
      token_version: 1,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/protegida',
      headers: { authorization: `Bearer ${staleJwt}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Sessão expirada' })

    // Sanity: JWT atual (token_version=2) deve passar.
    const freshJwt = app.jwt.sign({
      sub: 'user-42',
      tenant_id: 'tenant-1',
      papel: 'franqueado',
      nome: 'Fresh',
      email: 'fresh@x.com',
      token_version: 2,
    })
    const ok = await app.inject({
      method: 'GET',
      url: '/protegida',
      headers: { authorization: `Bearer ${freshJwt}` },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })

    await app.close()
  })
})
