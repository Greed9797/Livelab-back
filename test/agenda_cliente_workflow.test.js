import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'

function buildApp(queryMock) {
  const app = Fastify()
  const user = { tenant_id: 'tenant-a', sub: 'user-1', papel: 'franqueado' }

  app.decorate('authenticate', async (request) => {
    request.user = user
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    request.user = request.user ?? user
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (tenantId, fn) => fn({ query: queryMock }))

  return app
}

describe('agenda cliente workflow', () => {
  it('allows scheduling a cabine with cliente_id when no marca exists yet', async () => {
    const queryMock = vi.fn(async (sql, params = []) => {
      if (sql.includes('FROM clientes') && sql.includes('WHERE id = $1') && sql.includes('SELECT id')) {
        return { rows: [{ id: params[0], nome: 'Cliente Blumenau', tiktok_username: 'cliente_live', site: 'https://cliente.test' }] }
      }
      if (sql.includes('FROM cabines')) return { rows: [{ id: params[0] }] }
      if (sql.includes('FROM marcas') && sql.includes('cliente_id')) return { rows: [] }
      if (sql.includes('INSERT INTO marcas')) return { rows: [{ id: 'marca-1' }] }
      if (sql.includes('FROM agenda_eventos') && sql.includes('data_inicio <')) return { rows: [] }
      if (sql.includes('INSERT INTO agenda_eventos')) {
        return {
          rows: [{
            id: 'agenda-1',
            tenant_id: 'tenant-a',
            tipo: 'live',
            marca_id: params[2],
            cabine_id: params[3],
            data_inicio: params[5],
            data_fim: params[6],
            status: params[7],
          }],
        }
      }
      return { rows: [] }
    })

    const app = buildApp(queryMock)
    await app.register(agendaRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        cliente_id: '11111111-1111-4111-8111-111111111111',
        cabine_id: '22222222-2222-4222-8222-222222222222',
        data_inicio: '2026-05-18T13:00:00.000Z',
        data_fim: '2026-05-18T14:00:00.000Z',
        status: 'planejado',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().evento).toMatchObject({
      id: 'agenda-1',
      marca_id: 'marca-1',
      cabine_id: '22222222-2222-4222-8222-222222222222',
    })
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO marcas'))).toBe(true)

    await app.close()
  })
})
