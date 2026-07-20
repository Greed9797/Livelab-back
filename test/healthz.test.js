import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { healthHandler } from '../src/app.js'

// O healthcheck do Railway (railway.json → healthcheckPath) não manda header
// customizado. Se ele apontasse para /health com HEALTH_CHECK_TOKEN setado,
// receberia 404 e NENHUM deploy seria promovido. Estes testes travam essa
// diferença: /healthz é sempre público, /health continua protegido.
function buildHealthApp() {
  const app = Fastify()
  app.get('/health', healthHandler)
  app.get('/healthz', async () => ({ ok: true }))
  return app
}

const TOKEN_ORIGINAL = process.env.HEALTH_CHECK_TOKEN

afterEach(() => {
  if (TOKEN_ORIGINAL === undefined) delete process.env.HEALTH_CHECK_TOKEN
  else process.env.HEALTH_CHECK_TOKEN = TOKEN_ORIGINAL
})

describe('healthcheck', () => {
  it('/healthz responde 200 sem header mesmo com HEALTH_CHECK_TOKEN setado', async () => {
    process.env.HEALTH_CHECK_TOKEN = 'segredo-do-uptimerobot'
    const app = buildHealthApp()

    const res = await app.inject({ method: 'GET', url: '/healthz' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('/healthz não vaza commit sha nem estado interno', async () => {
    const app = buildHealthApp()

    const res = await app.inject({ method: 'GET', url: '/healthz' })

    expect(Object.keys(res.json())).toEqual(['ok'])
    await app.close()
  })

  it('/health continua exigindo o token quando ele está setado', async () => {
    process.env.HEALTH_CHECK_TOKEN = 'segredo-do-uptimerobot'
    const app = buildHealthApp()

    const semHeader = await app.inject({ method: 'GET', url: '/health' })
    const comHeader = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-health-token': 'segredo-do-uptimerobot' },
    })

    expect(semHeader.statusCode).toBe(404)
    expect(comHeader.statusCode).toBe(200)
    await app.close()
  })
})
