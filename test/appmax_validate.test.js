import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appmaxRoutes } from '../src/routes/appmax.js'

const APP_ID = 'APP_TESTE_123'
const FIXED_EXTERNAL_ID = '270e7c2d-8795-4320-856d-a4dd95cf727c'

function buildApp() {
  const app = Fastify()
  const query = vi.fn(async (sql) => {
    if (/INSERT INTO appmax_installations/i.test(sql)) return { rows: [{ external_id: 'ignored' }] }
    return { rows: [] }
  })
  app.decorate('db', { query })
  return { app, query }
}

describe('appmax validate', () => {
  beforeEach(() => {
    process.env.APPMAX_APP_ID = APP_ID
    process.env.APPMAX_EXTERNAL_ID = FIXED_EXTERNAL_ID
  })
  afterEach(() => {
    delete process.env.APPMAX_APP_ID
    delete process.env.APPMAX_EXTERNAL_ID
  })

  it('retorna 200 com external_id FIXO (key underscore)', async () => {
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/appmax/validate',
      payload: { app_id: APP_ID, client_id: 'cid1', client_secret: 'sec1', external_key: 'ekey1' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.external_id).toBe(FIXED_EXTERNAL_ID)
    expect(body).not.toHaveProperty('external-id')
    await app.close()
  })

  it('external_id é sempre o mesmo (fixo do app), qualquer instalação', async () => {
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const r1 = await app.inject({ method: 'POST', url: '/v1/webhooks/appmax/validate', payload: { app_id: APP_ID, client_id: 'A', external_key: 'kA' } })
    const r2 = await app.inject({ method: 'POST', url: '/v1/webhooks/appmax/validate', payload: { app_id: APP_ID, client_id: 'B', external_key: 'kB' } })
    expect(r1.json().external_id).toBe(FIXED_EXTERNAL_ID)
    expect(r2.json().external_id).toBe(FIXED_EXTERNAL_ID)
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

  it('503 se APPMAX_EXTERNAL_ID ausente', async () => {
    delete process.env.APPMAX_EXTERNAL_ID
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/appmax/validate', payload: { app_id: APP_ID } })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('GET healthcheck não expõe external_id falso', async () => {
    const { app } = buildApp()
    await app.register(appmaxRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/appmax/validate' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty('external_id')
    await app.close()
  })
})
