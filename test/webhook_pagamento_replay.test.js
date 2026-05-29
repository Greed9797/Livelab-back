// W3-B hardening: replay protection no webhook Pagar.me (POST /v1/webhooks/pagamento).
// Mocka app.db.query, app.withTenant, auth.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

import { boletosRoutes } from '../src/routes/boletos.js'

const TOKEN = 'test-webhook-token-32-chars-aaaaaaaaaaaaa'
const TENANT_A = '00000000-0000-0000-0000-00000000000a'
const BOLETO_A = '11111111-1111-1111-1111-111111111111'

function buildApp() {
  const app = Fastify()

  const dbQuery = vi.fn(async (sql) => {
    if (/INSERT INTO webhook_replay_log/i.test(sql)) {
      const isReplay = dbQuery._inserted
      dbQuery._inserted = true
      return isReplay ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ nonce: 'x' }] }
    }
    if (/SELECT id, tenant_id FROM boletos/i.test(sql)) {
      return { rows: [{ id: BOLETO_A, tenant_id: TENANT_A }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })

  const updateSpy = vi.fn(async () => ({ rowCount: 1, rows: [] }))

  app.decorate('db', { query: dbQuery })
  app.decorate('withTenant', async (_t, fn) => fn({ query: updateSpy }))

  // Auth/role decorators que boletosRoutes precisa, mas webhook não usa
  app.decorate('authenticate', async () => {})
  app.decorate('requirePapel', () => async () => {})

  return { app, dbQuery, updateSpy }
}

describe('POST /v1/webhooks/pagamento — replay protection', () => {
  beforeEach(() => {
    process.env.PAGAMENTO_WEBHOOK_TOKEN = TOKEN
    delete process.env.WEBHOOK_REPLAY_PROTECTION
  })
  afterEach(() => {
    delete process.env.PAGAMENTO_WEBHOOK_TOKEN
    delete process.env.WEBHOOK_REPLAY_PROTECTION
  })

  it('processa normalmente sem WEBHOOK_REPLAY_PROTECTION', async () => {
    const { app, dbQuery, updateSpy } = buildApp()
    await app.register(boletosRoutes)

    const payload = { id: 'gw-pay-001', status: 'paid' }
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pagamento',
      headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN },
      payload,
    })
    expect(r1.statusCode).toBe(200)
    expect(updateSpy).toHaveBeenCalled()

    const replayCalls = dbQuery.mock.calls.filter(c => /webhook_replay_log/i.test(c[0]))
    expect(replayCalls.length).toBe(0)
    await app.close()
  })

  it('bloqueia replay quando WEBHOOK_REPLAY_PROTECTION=true', async () => {
    process.env.WEBHOOK_REPLAY_PROTECTION = 'true'
    const { app, updateSpy } = buildApp()
    await app.register(boletosRoutes)

    const payload = { id: 'gw-pay-002', status: 'paid', event_id: 'evt-abc' }

    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pagamento',
      headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN },
      payload,
    })
    expect(r1.statusCode).toBe(200)

    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pagamento',
      headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN },
      payload,
    })
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).toMatchObject({ received: true, replay: true })
    // Update só ocorreu na primeira chamada
    expect(updateSpy).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('rejeita 401 com token incorreto (replay protection irrelevante)', async () => {
    process.env.WEBHOOK_REPLAY_PROTECTION = 'true'
    const { app, dbQuery } = buildApp()
    await app.register(boletosRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/pagamento',
      headers: { 'content-type': 'application/json', 'x-webhook-token': 'wrong-token-1234567890123456789012' },
      payload: { id: 'x', status: 'paid' },
    })
    expect(res.statusCode).toBe(401)
    // Não chegou nem a tentar inserir replay log
    const replayCalls = dbQuery.mock.calls.filter(c => /webhook_replay_log/i.test(c[0]))
    expect(replayCalls.length).toBe(0)
    await app.close()
  })
})
