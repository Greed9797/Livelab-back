import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { healthHandler } from '../src/app.js'

describe('healthcheck contract', () => {
  it('keeps /healthcheck compatible with the /health payload', async () => {
    const app = Fastify()
    app.get('/health', healthHandler)
    app.get('/healthcheck', healthHandler)

    const health = await app.inject({ method: 'GET', url: '/health' })
    const healthcheck = await app.inject({ method: 'GET', url: '/healthcheck' })

    expect(health.statusCode).toBe(200)
    expect(healthcheck.statusCode).toBe(200)
    expect(healthcheck.json()).toEqual(health.json())

    await app.close()
  })
})
