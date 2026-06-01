import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { boletosRoutes } from '../src/routes/boletos.js'
import { clientePortalRoutes } from '../src/routes/cliente_portal.js'
import { knowledgeRoutes } from '../src/routes/knowledge.js'

function buildClienteApp() {
  const app = Fastify()
  const queryMock = vi.fn()
  app.decorate('authenticate', async (request) => {
    request.user = {
      sub: 'user-1',
      tenant_id: '11111111-1111-4111-8111-111111111111',
      papel: 'cliente_parceiro',
    }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) {
      request.user = {
        sub: 'user-1',
        tenant_id: '11111111-1111-4111-8111-111111111111',
        papel: 'cliente_parceiro',
      }
    }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('db', {
    query: queryMock,
    pool: {
      connect: vi.fn().mockResolvedValue({ query: queryMock, release: vi.fn() }),
    },
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: vi.fn() }))
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query: queryMock, release: vi.fn() }))
  return { app, queryMock }
}

describe('cliente role go-live scope', () => {
  it('blocks knowledge base for cliente_parceiro before querying data', async () => {
    const { app, queryMock } = buildClienteApp()
    await app.register(knowledgeRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/knowledge/categories' })

    expect(response.statusCode).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('blocks boletos/financeiro shortcut for cliente_parceiro before querying data', async () => {
    const { app, queryMock } = buildClienteApp()
    await app.register(boletosRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/boletos' })

    expect(response.statusCode).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('keeps cliente meta read-only and blocks restricted cliente endpoints before querying data', async () => {
    const { app, queryMock } = buildClienteApp()
    await app.register(clientePortalRoutes)

    const responses = await Promise.all([
      app.inject({ method: 'PATCH', url: '/v1/cliente/meta', payload: { ano: 2026, mes: 5, meta_gmv: 1000 } }),
      app.inject({ method: 'GET', url: '/v1/cliente/agenda?data_inicio=2026-05-01&data_fim=2026-05-07' }),
      app.inject({ method: 'GET', url: '/v1/cliente/reservas' }),
      app.inject({ method: 'POST', url: '/v1/cliente/solicitacao', payload: {} }),
      app.inject({ method: 'GET', url: '/v1/contratos/meu' }),
    ])

    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403])
    expect(responses[0].json().error).toMatch(/apenas para visualização/)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('allows cliente settings read-only data: perfil and meta', async () => {
    const { app, queryMock } = buildClienteApp()
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          id: 'cliente-1',
          nome: 'Cliente A',
          email: 'cliente@example.com',
          celular: null,
          cnpj: null,
          razao_social: null,
          site: null,
          logo_url: null,
          status: 'ativo',
          fat_anual: null,
          nicho: null,
          cidade: null,
          estado: null,
          tiktok_username: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'cliente-1' }] })
      .mockResolvedValueOnce({ rows: [{ meta_gmv: '1000.00' }] })

    await app.register(clientePortalRoutes)

    const perfil = await app.inject({ method: 'GET', url: '/v1/cliente/perfil' })
    const meta = await app.inject({ method: 'GET', url: '/v1/cliente/meta?ano=2026&mes=5' })

    expect(perfil.statusCode).toBe(200)
    expect(perfil.json()).toMatchObject({ id: 'cliente-1', nome: 'Cliente A', email: 'cliente@example.com' })
    expect(meta.statusCode).toBe(200)
    expect(meta.json()).toEqual({ ano: 2026, mes: 5, meta_gmv: 1000 })
    await app.close()
  })
})
