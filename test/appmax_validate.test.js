import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appmaxRoutes } from '../src/routes/appmax.js'

const APP_ID = 'APP_TESTE_123'

// Mock db com store em memória pra simular idempotência por identidade.
function buildApp() {
  const app = Fastify()
  const store = new Map() // key: app_id|client_id|external_key → external_id

  const query = vi.fn(async (sql, params) => {
    if (/SELECT external_id FROM appmax_installations/i.test(sql)) {
      const [appId, cid, ekey] = params
      const key = `${appId}|${cid}|${ekey}`
      const ext = store.get(key)
      return { rows: ext ? [{ external_id: ext }] : [] }
    }
    if (/UPDATE appmax_installations/i.test(sql)) {
      return { rows: [] }
    }
    if (/INSERT INTO appmax_installations/i.test(sql)) {
      const [appId, clientId, , externalKey] = params
      const key = `${appId}|${clientId ?? ''}|${externalKey ?? ''}`
      const ext = `ext-${store.size + 1}-${Math.random().toString(16).slice(2, 8)}`
      store.set(key, ext)
      return { rows: [{ external_id: ext }] }
    }
    return { rows: [] }
  })

  app.decorate('db', { query })
  return { app, query, store }
}

describe('appmax validate', () => {
  beforeEach(() => { process.env.APPMAX_APP_ID = APP_ID })
  afterEach(() => { delete process.env.APPMAX_APP_ID })

  it('retorna 200 com external_id (key underscore) no POST', async () => {
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax/validate',
      payload: { app_id: APP_ID, client_id: 'cid1', client_secret: 'sec1', external_key: 'ekey1' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('external_id')
    expect(body).not.toHaveProperty('external-id')
    expect(typeof body.external_id).toBe('string')
    await app.close()
  })

  it('mesma instalação retorna o MESMO external_id (idempotência)', async () => {
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const payload = { app_id: APP_ID, client_id: 'cid1', client_secret: 'sec1', external_key: 'ekey1' }
    const r1 = await app.inject({ method: 'POST', url: '/v1/webhooks/appmax/validate', payload })
    const r2 = await app.inject({ method: 'POST', url: '/v1/webhooks/appmax/validate', payload })
    expect(r1.json().external_id).toBe(r2.json().external_id)
    await app.close()
  })

  it('instalações diferentes geram external_id distinto', async () => {
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const r1 = await app.inject({ method: 'POST', url: '/v1/webhooks/appmax/validate', payload: { app_id: APP_ID, client_id: 'cidA', external_key: 'kA' } })
    const r2 = await app.inject({ method: 'POST', url: '/v1/webhooks/appmax/validate', payload: { app_id: APP_ID, client_id: 'cidB', external_key: 'kB' } })
    expect(r1.json().external_id).not.toBe(r2.json().external_id)
    await app.close()
  })

  it('rejeita app_id divergente com 401', async () => {
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax/validate',
      payload: { app_id: 'OUTRO_APP', client_id: 'x' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET healthcheck não expõe external_id falso', async () => {
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/appmax/validate' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty('external-id')
    expect(body).not.toHaveProperty('external_id')
    await app.close()
  })
})
