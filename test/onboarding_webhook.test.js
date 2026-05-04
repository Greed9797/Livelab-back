import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import crypto from 'node:crypto'

import onboardingRoutes from '../src/routes/onboarding.js'

const VALID_BODY = {
  company_name: 'Loja Teste',
  responsible_name: 'João Silva',
  main_products: 'Roupas femininas',
  sales_history: 'R$ 50k/mês',
  focus_products: 'Vestidos',
  current_stock: '500 peças',
  product_margin: '40%',
  gmv_expectation: 'R$ 100k',
  traffic_budget: 'R$ 5k',
  website_url: null,
  instagram_url: null,
  tiktok_url: null,
  tiktok_shop_url: null,
  available_offers: null,
  live_experience: 'low',
}

async function buildApp({ existingOnboarding = false } = {}) {
  const app = Fastify()

  const queryMock = vi.fn(async (sql) => {
    if (sql.includes('SELECT id FROM onboarding_responses')) {
      return { rows: existingOnboarding ? [{ id: 'x' }] : [] }
    }
    if (sql.includes('INSERT INTO onboarding_responses')) {
      return { rows: [] }
    }
    if (sql.includes('UPDATE users SET onboarding_completed')) {
      return { rows: [] }
    }
    if (sql.includes('SELECT email, nome FROM users')) {
      return { rows: [{ email: 'cliente@teste.com', nome: 'João Silva' }] }
    }
    return { rows: [] }
  })

  app.decorate('db', { query: queryMock })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: vi.fn() }))
  app.decorate('authenticate', async (req) => {
    req.user = {
      sub: '00000000-0000-0000-0000-000000000010',
      tenant_id: '00000000-0000-0000-0000-000000000001',
      papel: 'cliente_parceiro',
    }
  })
  app.decorate('requirePapel', (papeis) => async (req, reply) => {
    if (!papeis.includes(req.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })

  await app.register(onboardingRoutes)
  return { app, queryMock }
}

describe('POST /v1/onboarding — bio CRM webhook', () => {
  const realFetch = global.fetch
  let fetchSpy

  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    global.fetch = fetchSpy
  })

  afterEach(() => {
    global.fetch = realFetch
    delete process.env.BIO_CRM_WEBHOOK_URL
    delete process.env.BIO_CRM_WEBHOOK_SECRET
  })

  it('responde 200 e dispara webhook quando BIO_CRM_WEBHOOK_URL setado', async () => {
    process.env.BIO_CRM_WEBHOOK_URL = 'https://crm.example.com/hook'
    const { app } = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      payload: VALID_BODY,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    // fire-and-forget — pode não ter rodado ainda no microtask. Espera tick.
    await new Promise((r) => setImmediate(r))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://crm.example.com/hook')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')

    const payload = JSON.parse(init.body)
    expect(payload.event).toBe('onboarding.completed')
    expect(payload.user_id).toBe('00000000-0000-0000-0000-000000000010')
    expect(payload.tenant_id).toBe('00000000-0000-0000-0000-000000000001')
    expect(payload.user_email).toBe('cliente@teste.com')
    expect(payload.data.company_name).toBe('Loja Teste')
    expect(payload.data.live_experience).toBe('low')
    expect(payload.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    await app.close()
  })

  it('inclui assinatura HMAC quando BIO_CRM_WEBHOOK_SECRET setado', async () => {
    process.env.BIO_CRM_WEBHOOK_URL = 'https://crm.example.com/hook'
    process.env.BIO_CRM_WEBHOOK_SECRET = 'super-secret-32-chars-minimum-please'
    const { app } = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      payload: VALID_BODY,
    })
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setImmediate(r))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0][1]
    expect(init.headers['X-Livelab-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)

    const expected = crypto
      .createHmac('sha256', 'super-secret-32-chars-minimum-please')
      .update(init.body)
      .digest('hex')
    expect(init.headers['X-Livelab-Signature']).toBe(`sha256=${expected}`)

    await app.close()
  })

  it('responde 200 mesmo se webhook falhar (rede/timeout/5xx)', async () => {
    process.env.BIO_CRM_WEBHOOK_URL = 'https://crm.example.com/hook'
    fetchSpy = vi.fn(async () => { throw new Error('ECONNRESET') })
    global.fetch = fetchSpy
    const { app } = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      payload: VALID_BODY,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    await app.close()
  })

  it('NÃO dispara webhook quando BIO_CRM_WEBHOOK_URL ausente', async () => {
    const { app } = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      payload: VALID_BODY,
    })
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setImmediate(r))
    expect(fetchSpy).not.toHaveBeenCalled()

    await app.close()
  })

  it('NÃO dispara webhook quando onboarding já existe (409)', async () => {
    process.env.BIO_CRM_WEBHOOK_URL = 'https://crm.example.com/hook'
    const { app } = await buildApp({ existingOnboarding: true })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      payload: VALID_BODY,
    })
    expect(res.statusCode).toBe(409)
    await new Promise((r) => setImmediate(r))
    expect(fetchSpy).not.toHaveBeenCalled()

    await app.close()
  })
})
