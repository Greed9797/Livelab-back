import Fastify from 'fastify'
import cors from '@fastify/cors'
import { describe, expect, it } from 'vitest'

import { corsAllowedHeaders } from '../src/app.js'

describe('browser CORS allowlist', () => {
  it('echoes Idempotency-Key so the knowledge editor preflight succeeds', async () => {
    expect(corsAllowedHeaders).toContain('Idempotency-Key')

    const app = Fastify()
    await app.register(cors, {
      origin: 'https://app.grupolivelab.com.br',
      credentials: true,
      allowedHeaders: corsAllowedHeaders,
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    })

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/knowledge/unit/materials',
      headers: {
        origin: 'https://app.grupolivelab.com.br',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key',
      },
    })

    expect(response.statusCode).toBe(204)
    expect(String(response.headers['access-control-allow-origin'])).toBe('https://app.grupolivelab.com.br')
    const allowed = String(response.headers['access-control-allow-headers']).toLowerCase()
    expect(allowed).toContain('authorization')
    expect(allowed).toContain('content-type')
    expect(allowed).toContain('idempotency-key')
    await app.close()
  })
})
