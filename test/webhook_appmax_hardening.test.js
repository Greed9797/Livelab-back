// W3-B hardening: testes pra B3.1 (cross-tenant fraud) + B3.2 (replay protection)
// no webhook Appmax (POST /v1/webhooks/appmax).
//
// Mocka app.db.query, app.withTenant. Não toca rede nem banco real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

import { appmaxRoutes } from '../src/routes/appmax.js'

const APP_ID = 'test-app-id-123'
const SECRET = 'test-secret-32-chars-minimum-aaaaaaaa'

const TENANT_A = '00000000-0000-0000-0000-00000000000a'
const TENANT_B = '00000000-0000-0000-0000-00000000000b'
const BOLETO_A = '11111111-1111-1111-1111-111111111111'

function paidPayload({ gatewayId = 'gw-12345', extra = {} } = {}) {
  return {
    app_id: APP_ID,
    event: 'OrderPaid',
    data: {
      id: gatewayId,
      ...extra,
    },
  }
}

function buildApp({ lookupRows = [], updateSpy } = {}) {
  const app = Fastify()

  // Mock pool-level db
  const dbQuery = vi.fn(async (sql, params) => {
    if (/INSERT INTO webhook_eventos/i.test(sql)) {
      return { rowCount: 1, rows: [] }
    }
    if (/INSERT INTO webhook_replay_log/i.test(sql)) {
      // Default: aceita primeiro insert
      const nonce = params[1]
      if (dbQuery.replayInserted?.has(nonce)) {
        return { rowCount: 0, rows: [] }
      }
      dbQuery.replayInserted ??= new Set()
      dbQuery.replayInserted.add(nonce)
      return { rowCount: 1, rows: [{ nonce }] }
    }
    if (/SELECT id, tenant_id FROM boletos/i.test(sql)) {
      return { rows: lookupRows, rowCount: lookupRows.length }
    }
    return { rows: [], rowCount: 0 }
  })

  app.decorate('db', { query: dbQuery })

  // withTenant mock — captura tenant_id usado e roteia query pro updateSpy
  const tenantContext = vi.fn()
  app.decorate('withTenant', async (tenantId, fn) => {
    tenantContext(tenantId)
    return fn({
      query: updateSpy ?? (async () => ({ rowCount: 1, rows: [] })),
    })
  })

  return { app, dbQuery, tenantContext }
}

describe('POST /v1/webhooks/appmax — hardening B3.1 + B3.2', () => {
  beforeEach(() => {
    process.env.APPMAX_APP_ID = APP_ID
    process.env.APPMAX_WEBHOOK_SECRET = SECRET
    delete process.env.WEBHOOK_REPLAY_PROTECTION
  })

  afterEach(() => {
    delete process.env.APPMAX_APP_ID
    delete process.env.APPMAX_WEBHOOK_SECRET
    delete process.env.WEBHOOK_REPLAY_PROTECTION
  })

  it('B3.1: usa withTenant pra UPDATE quando boleto encontrado (RLS-safe)', async () => {
    const updateSpy = vi.fn(async () => ({ rowCount: 1, rows: [] }))
    const { app, tenantContext } = buildApp({
      lookupRows: [{ id: BOLETO_A, tenant_id: TENANT_A }],
      updateSpy,
    })
    await app.register(appmaxRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax',
      headers: { 'content-type': 'application/json', 'x-appmax-token': SECRET },
      payload: paidPayload(),
    })

    expect(res.statusCode).toBe(200)
    // Deve ter chamado withTenant com o tenant_id do boleto encontrado
    expect(tenantContext).toHaveBeenCalledWith(TENANT_A)
    // E o UPDATE precisa incluir filtro tenant_id explícito
    expect(updateSpy).toHaveBeenCalled()
    const updateSql = updateSpy.mock.calls[0][0]
    expect(updateSql).toMatch(/UPDATE boletos/i)
    expect(updateSql).toMatch(/tenant_id\s*=\s*\$2/i)
    await app.close()
  })

  it('B3.1: rejeita 409 quando referência colide entre tenants', async () => {
    const updateSpy = vi.fn()
    const { app } = buildApp({
      lookupRows: [
        { id: BOLETO_A, tenant_id: TENANT_A },
        { id: '22222222-2222-2222-2222-222222222222', tenant_id: TENANT_B },
      ],
      updateSpy,
    })
    await app.register(appmaxRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax',
      headers: { 'content-type': 'application/json', 'x-appmax-token': SECRET },
      payload: paidPayload(),
    })

    expect(res.statusCode).toBe(409)
    expect(updateSpy).not.toHaveBeenCalled()
    await app.close()
  })

  it('B3.2: replay protection desativada por padrão (sem env)', async () => {
    const updateSpy = vi.fn(async () => ({ rowCount: 1, rows: [] }))
    const { app, dbQuery } = buildApp({
      lookupRows: [{ id: BOLETO_A, tenant_id: TENANT_A }],
      updateSpy,
    })
    await app.register(appmaxRoutes)

    const payload = paidPayload()
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax',
      headers: { 'content-type': 'application/json', 'x-appmax-token': SECRET },
      payload,
    })
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax',
      headers: { 'content-type': 'application/json', 'x-appmax-token': SECRET },
      payload,
    })

    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).not.toHaveProperty('replay')
    // Sem replay protection: 2 chamadas processam normalmente, sem INSERT em webhook_replay_log
    const replayInserts = dbQuery.mock.calls.filter(c => /webhook_replay_log/i.test(c[0]))
    expect(replayInserts.length).toBe(0)
    await app.close()
  })

  it('B3.2: replay bloqueado quando WEBHOOK_REPLAY_PROTECTION=true e mesmo nonce', async () => {
    process.env.WEBHOOK_REPLAY_PROTECTION = 'true'
    const updateSpy = vi.fn(async () => ({ rowCount: 1, rows: [] }))
    const { app, dbQuery } = buildApp({
      lookupRows: [{ id: BOLETO_A, tenant_id: TENANT_A }],
      updateSpy,
    })
    await app.register(appmaxRoutes)

    const payload = paidPayload({ gatewayId: 'replay-test-001' })

    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax',
      headers: { 'content-type': 'application/json', 'x-appmax-token': SECRET },
      payload,
    })
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toMatchObject({ received: true })

    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax',
      headers: { 'content-type': 'application/json', 'x-appmax-token': SECRET },
      payload,
    })
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).toMatchObject({ received: true, replay: true })

    // Insert tentado 2x, mas só 1 produziu update real
    const replayInserts = dbQuery.mock.calls.filter(c => /webhook_replay_log/i.test(c[0]))
    expect(replayInserts.length).toBe(2)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('B3.2: replay protection usa source=appmax', async () => {
    process.env.WEBHOOK_REPLAY_PROTECTION = 'true'
    const { app, dbQuery } = buildApp({
      lookupRows: [{ id: BOLETO_A, tenant_id: TENANT_A }],
      updateSpy: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    })
    await app.register(appmaxRoutes)

    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax',
      headers: { 'content-type': 'application/json', 'x-appmax-token': SECRET },
      payload: paidPayload({ gatewayId: 'src-test-001' }),
    })

    const replayInsert = dbQuery.mock.calls.find(c => /webhook_replay_log/i.test(c[0]))
    expect(replayInsert).toBeDefined()
    expect(replayInsert[1][0]).toBe('appmax')
    await app.close()
  })
})
