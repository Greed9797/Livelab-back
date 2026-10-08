import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

import { tiktokRoutes } from '../src/routes/tiktok.js'
import { createSignedState } from '../src/services/oauth-state.js'

const envKeys = ['TIKTOK_OAUTH_ENABLED', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI', 'OAUTH_STATE_SECRET', 'TOKEN_ENCRYPTION_KEY', 'FRONTEND_URL']
const envSnapshot = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of envKeys) {
    if (envSnapshot[key] === undefined) delete process.env[key]
    else process.env[key] = envSnapshot[key]
  }
  vi.unstubAllGlobals()
})

function buildApp({ tenant } = {}) {
  const app = Fastify()
  const query = vi.fn().mockResolvedValue({ rows: [tenant ?? {}] })
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('db', { query })
  return { app, query }
}

describe('GET /v1/tiktok/status', () => {
  it('reports local credential state separately from OAuth availability and external verification', async () => {
    process.env.TIKTOK_OAUTH_ENABLED = 'true'
    process.env.TIKTOK_CLIENT_KEY = 'client-key'
    process.env.TIKTOK_CLIENT_SECRET = 'client-secret'
    process.env.TIKTOK_REDIRECT_URI = 'https://api.example.com/v1/tiktok/callback'
    const { app } = buildApp({
      tenant: {
        tiktok_access_token: 'encrypted-token', tiktok_user_id: 'open-id-1',
        tiktok_token_expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    await app.register(tiktokRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/tiktok/status' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      connected: false,
      capability: { supported: true, oauth: { available: true, reason: null }, scope: 'user.info.basic' },
      credential: { registered: true, valid_by_expiry: false, externally_verified: false },
    })
    expect(response.body).not.toContain('encrypted-token')
    await app.close()
  })

  it('does not present OAuth as available when the server flag is disabled', async () => {
    delete process.env.TIKTOK_OAUTH_ENABLED
    delete process.env.TIKTOK_CLIENT_KEY
    delete process.env.TIKTOK_CLIENT_SECRET
    delete process.env.TIKTOK_REDIRECT_URI
    const { app } = buildApp({ tenant: { tiktok_access_token: null } })
    await app.register(tiktokRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/tiktok/status' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      connected: false,
      capability: { oauth: { available: false, reason: 'oauth_disabled' } },
      credential: { registered: false, valid_by_expiry: null, externally_verified: false },
    })
    await app.close()
  })
})

describe('GET /v1/tiktok/callback', () => {
  it('allows only its nonce-authorized callback script under CSP', async () => {
    process.env.TIKTOK_OAUTH_ENABLED = 'true'
    process.env.TIKTOK_CLIENT_KEY = 'client-key'
    process.env.TIKTOK_CLIENT_SECRET = 'client-secret'
    process.env.TIKTOK_REDIRECT_URI = 'https://api.example.com/v1/tiktok/callback'
    process.env.OAUTH_STATE_SECRET = 'test-state-secret-that-is-long-enough-123456'
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64)
    process.env.FRONTEND_URL = 'https://app.example.com'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({
      access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, open_id: 'open-id',
    }) }))

    const { app, query } = buildApp()
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'tenant-1' }] })
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] })
    await app.register(tiktokRoutes)

    const state = createSignedState({ tenantId: 'tenant-1', nonce: 'nonce-1' })
    const response = await app.inject({ method: 'GET', url: `/v1/tiktok/callback?code=one-time-code&state=${encodeURIComponent(state)}` })
    const csp = response.headers['content-security-policy']
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1]

    expect(response.statusCode).toBe(200)
    expect(nonce).toBeTruthy()
    expect(response.body).toContain(`<script nonce="${nonce}">`)
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    await app.close()
  })
})
