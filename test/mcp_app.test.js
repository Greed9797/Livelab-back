import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, it, expect, vi } from 'vitest'
vi.mock('../src/plugins/db.js', async () => {
  const { default: fp } = await import('fastify-plugin')
  return { dbPlugin: fp(async app => {
    app.decorate('db', { query: async () => ({ rows: [] }) })
    app.decorate('withTenant', async (_tenant, fn) => fn(app.db))
  }, { name: 'db' }) }
})
import { buildApp } from '../src/app.js'

afterEach(() => vi.unstubAllEnvs())
function configure() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const env = { MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'https://livelab.test', MCP_CHATGPT_CLIENT_ID: 'chatgpt-test',
    MCP_CHATGPT_REDIRECT_URI: 'https://chatgpt.com/connector/oauth/test', MCP_STORAGE_KEY: Buffer.alloc(32, 8).toString('base64'),
    MCP_COOKIE_KEYS: JSON.stringify(['synthetic-mcp-cookie-key-at-least-32-characters']),
    MCP_JWKS: JSON.stringify({ keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'RS256' }] }),
    JWT_SECRET: 'synthetic-mcp-jwt-key-at-least-32-characters', CORS_ORIGIN: 'https://app.livelab.test' }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
}
describe('MCP na aplicação completa', () => {
  it('aceita preflight ChatGPT e header de versão apenas com MCP habilitado', async () => {
    configure()
    const app = await buildApp({ logger: false })
    try {
      const res = await app.inject({ method: 'OPTIONS', url: '/mcp', headers: {
        origin: 'https://chatgpt.com', 'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,mcp-protocol-version',
      } })
      expect(res.statusCode, res.body).toBe(204)
      expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('mcp-protocol-version')
      const unauthenticated = await app.inject({ method: 'POST', url: '/mcp', payload: {}, headers: { origin: 'https://chatgpt.com' } })
      expect(unauthenticated.statusCode).toBe(401)
      expect(unauthenticated.headers['access-control-allow-origin']).toBe('https://chatgpt.com')
      const other = await app.inject({ url: '/v1/analytics/dashboard', headers: { origin: 'https://chatgpt.com' } })
      expect(other.statusCode).toBe(403)
    } finally { await app.close() }
  })
  it('mantém integração ausente e CORS anterior quando desligada', async () => {
    configure(); vi.stubEnv('MCP_ENABLED', 'false')
    const app = await buildApp({ logger: false })
    try {
      expect((await app.inject('/mcp')).statusCode).toBe(404)
      const res = await app.inject({ method: 'OPTIONS', url: '/mcp', headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST' } })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    } finally { await app.close() }
  })
})
