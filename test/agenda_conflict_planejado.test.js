// Regressão: GET /v1/agenda/conflitos não deve marcar status='planejado'
// como conflito. POST /v1/lives já reusa o evento via agenda_evento_id —
// bloquear planejado aqui impedia o usuário de iniciar a própria live.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'

const tenantId = '11111111-1111-4111-8111-111111111111'

function buildApp({ queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })

  return { app, query }
}

describe('GET /v1/agenda/conflitos — planejado não bloqueia', () => {
  it('passa apenas confirmado e ao_vivo no SELECT (status=ANY)', async () => {
    const { app, query } = buildApp()
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/agenda/conflitos?cabine_id=00000000-0000-0000-0000-000000000005&data_inicio=2026-05-27T09:00:00Z&data_fim=2026-05-27T13:00:00Z`,
    })
    expect(res.statusCode).toBe(200)

    const call = query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM agenda_eventos ae')
    )
    expect(call).toBeTruthy()
    const values = call[1]
    // values[3] = array de status considerados conflito
    expect(values[3]).toEqual(['confirmado', 'ao_vivo'])
    expect(values[3]).not.toContain('planejado')

    await app.close()
  })

  it('retorna 0 conflitos quando query mockada retorna vazio (agenda só planejada)', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({ queryMock })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/agenda/conflitos?cabine_id=00000000-0000-0000-0000-000000000005&data_inicio=2026-05-27T09:00:00Z&data_fim=2026-05-27T13:00:00Z`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ conflitos: [], total: 0 })

    await app.close()
  })

  it('retorna conflito quando agenda está confirmado ou ao_vivo', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{
        id: 'evt-1',
        tipo: 'live',
        cabine_id: '00000000-0000-0000-0000-000000000005',
        data_inicio: '2026-05-27T08:00:00Z',
        data_fim: '2026-05-27T14:00:00Z',
        status: 'ao_vivo',
        entidade: 'cabine',
      }],
    })
    const { app } = buildApp({ queryMock })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/agenda/conflitos?cabine_id=00000000-0000-0000-0000-000000000005&data_inicio=2026-05-27T09:00:00Z&data_fim=2026-05-27T13:00:00Z`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe(1)

    await app.close()
  })
})
