import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { clienteBriefingRoutes } from '../src/routes/cliente_briefing.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const CLIENTE = '22222222-2222-4222-8222-222222222222'

function buildApp(papel = 'franqueado') {
  const app = Fastify()
  const queryMock = vi.fn()
  app.decorate('authenticate', async (request) => {
    request.user = { sub: 'user-1', nome: 'Fulano', tenant_id: TENANT, papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { sub: 'user-1', nome: 'Fulano', tenant_id: TENANT, papel }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query: queryMock, release: vi.fn() }))
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })
  return { app, queryMock }
}

describe('cliente briefing', () => {
  it('GET retorna null quando o briefing ainda não existe', async () => {
    const { app, queryMock } = buildApp('franqueado')
    queryMock.mockResolvedValueOnce({ rows: [] })
    await app.register(clienteBriefingRoutes)

    const res = await app.inject({ method: 'GET', url: `/v1/clientes/${CLIENTE}/briefing` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
    // defesa em profundidade: o SELECT carrega tenant_id explícito
    expect(queryMock.mock.calls[0][0]).toContain('tenant_id = $2')
    expect(queryMock.mock.calls[0][1]).toEqual([CLIENTE, TENANT])
    await app.close()
  })

  it('PUT faz upsert (cria ou sobrescreve via ON CONFLICT)', async () => {
    const { app, queryMock } = buildApp('franqueado')
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: CLIENTE }] }) // cliente existe no tenant
      .mockResolvedValueOnce({ rows: [{ id: 'brief-1', cliente_id: CLIENTE, conteudo: '# Oi', atualizado_por_nome: 'Fulano' }] })
    await app.register(clienteBriefingRoutes)

    const res = await app.inject({ method: 'PUT', url: `/v1/clientes/${CLIENTE}/briefing`, payload: { conteudo: '# Oi' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'brief-1', conteudo: '# Oi' })
    // upsert real garantido pelo ON CONFLICT + UNIQUE(cliente_id) da migration
    expect(queryMock.mock.calls[1][0]).toContain('ON CONFLICT (cliente_id)')
    await app.close()
  })

  it('PUT retorna 404 quando o cliente não pertence ao tenant', async () => {
    const { app, queryMock } = buildApp('franqueado')
    queryMock.mockResolvedValueOnce({ rows: [] }) // cliente não existe no tenant
    await app.register(clienteBriefingRoutes)

    const res = await app.inject({ method: 'PUT', url: `/v1/clientes/${CLIENTE}/briefing`, payload: { conteudo: 'x' } })

    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PUT rejeita payload inválido (conteudo não-string) sem tocar o banco', async () => {
    const { app, queryMock } = buildApp('franqueado')
    await app.register(clienteBriefingRoutes)

    const res = await app.inject({ method: 'PUT', url: `/v1/clientes/${CLIENTE}/briefing`, payload: { conteudo: 123 } })

    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('bloqueia escrita de papel read-only (operacional lê clientes mas não escreve) antes de tocar o banco', async () => {
    const { app, queryMock } = buildApp('operacional') // em READ_CLIENTES, fora de WRITE_CLIENTES
    await app.register(clienteBriefingRoutes)

    const res = await app.inject({ method: 'PUT', url: `/v1/clientes/${CLIENTE}/briefing`, payload: { conteudo: 'x' } })

    expect(res.statusCode).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('bloqueia leitura de papel fora de READ_CLIENTES (apresentador) antes de tocar o banco', async () => {
    const { app, queryMock } = buildApp('apresentador')
    await app.register(clienteBriefingRoutes)

    const res = await app.inject({ method: 'GET', url: `/v1/clientes/${CLIENTE}/briefing` })

    expect(res.statusCode).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })
})
