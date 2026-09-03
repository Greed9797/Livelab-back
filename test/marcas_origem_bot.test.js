import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { marcasRoutes } from '../src/routes/marcas.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const chave = { id: '66666666-6666-4666-8666-666666666666', nome: 'grok bot' }

function buildApp({ viaApiKey } = {}) {
  const app = Fastify()
  const query = vi.fn(async (sql) => {
    if (/INSERT INTO marcas/.test(sql)) return { rows: [{ id: 'marca-nova', nome: 'Nova', tipo: 'afiliada' }] }
    return { rows: [] }
  })
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: viaApiKey ? null : 'user-1', papel: viaApiKey ? 'automacao' : 'franqueado' }
    if (viaApiKey) request.viaApiKey = viaApiKey
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query, release: vi.fn() }))
  app.decorate('dbTenant', async () => ({ query, release: vi.fn() }))
  return { app, query }
}

const insertMarcasArgs = (query) => query.mock.calls.find(([sql]) => /INSERT INTO marcas/.test(sql))[1]
const payload = { nome: 'Nova', tipo: 'afiliada', status: 'ativa' }

describe('origem_dados de marca (BOT)', () => {
  it("POST /v1/marcas por chave grava origem_dados='bot'", async () => {
    const { app, query } = buildApp({ viaApiKey: chave })
    await app.register(marcasRoutes)

    const res = await app.inject({ method: 'POST', url: '/v1/marcas', payload })

    expect(res.statusCode).toBe(201)
    expect(insertMarcasArgs(query)).toContain('bot')
    expect(insertMarcasArgs(query)).not.toContain('manual')
  })

  it("POST /v1/marcas por JWT grava origem_dados='manual'", async () => {
    const { app, query } = buildApp()
    await app.register(marcasRoutes)

    const res = await app.inject({ method: 'POST', url: '/v1/marcas', payload })

    expect(res.statusCode).toBe(201)
    expect(insertMarcasArgs(query)).toContain('manual')
    expect(insertMarcasArgs(query)).not.toContain('bot')
  })

  it('GET /v1/marcas devolve origem_dados de cada marca', async () => {
    const { app, query } = buildApp()
    await app.register(marcasRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/marcas' })

    expect(res.statusCode).toBe(200)
    const listagem = query.mock.calls.find(([sql]) => /FROM marcas m/.test(sql))
    expect(listagem[0]).toContain('m.origem_dados')
  })
})
