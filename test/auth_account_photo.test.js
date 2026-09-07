import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { authRoutes } from '../src/routes/auth.js'
vi.mock('bcrypt', () => ({ default: { compare: vi.fn(async (password) => password === 'Correct123'), hash: vi.fn(async () => 'hash') } }))
const user = { id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222', papel: 'apresentadora', nome: 'Ana', email: 'ana@example.com', ativo: true, senha_hash: 'hash' }
async function setup() {
  const app = Fastify()
  const sign = vi.fn(() => 'access')
  const query = vi.fn(async (sql) => {
    if (sql.includes('SELECT foto_url')) return { rows: [{ foto_url: 'https://example.com/avatar.jpg' }] }
    if (sql.includes('SELECT u.*')) return { rows: [user] }
    if (sql.includes('SELECT rt.*')) return { rows: [{ ...user, user_id: user.id }] }
    if (sql.includes('RETURNING id, tenant_id, papel')) return { rows: [user], rowCount: 1 }
    if (sql.includes('SELECT nome FROM tenants')) return { rows: [{ nome: 'Unidade' }] }
    return { rows: [], rowCount: 1 }
  })
  app.decorate('db', { query })
  app.decorate('jwt', { sign })
  app.decorate('authenticate', async () => {})
  await app.register(authRoutes)
  return { app, query, sign }
}
describe('authenticated account photo DTO', () => {
  it.each([
    ['/v1/auth/login', { email: user.email, senha: 'Correct123' }],
    ['/v1/auth/refresh', { refresh_token: 'a'.repeat(80) }],
    ['/v1/auth/aceitar-convite', { token: 'a'.repeat(64), nova_senha: 'Correct123' }],
  ])('%s returns own photo without embedding it in JWT', async (url, payload) => {
    const { app, sign } = await setup()
    try {
      const response = await app.inject({ method: 'POST', url, payload })
      expect(response.statusCode).toBe(200)
      expect(response.json().user).toMatchObject({ id: user.id, foto_url: 'https://example.com/avatar.jpg' })
      expect(sign).toHaveBeenCalledOnce()
      expect(sign.mock.calls[0][0]).not.toHaveProperty('foto_url')
    } finally { await app.close() }
  })
  it('does not look up or expose a photo for invalid credentials', async () => {
    const { app, query } = await setup()
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: user.email, senha: 'Wrong123' } })
      expect(response.statusCode).toBe(401)
      expect(response.json()).not.toHaveProperty('user')
      expect(query.mock.calls.some(([sql]) => sql.includes('SELECT foto_url'))).toBe(false)
    } finally { await app.close() }
  })
})
