import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const apresentadoraId = '33333333-3333-4333-8333-333333333333'
const eventoId = '44444444-4444-4444-8444-444444444444'

function buildApp(query) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    request.user ??= { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })
  return app
}

const novoEvento = {
  tipo: 'live',
  marca_id: marcaId,
  data_inicio: '2026-09-15T13:00:00.000Z',
  data_fim: '2026-09-15T14:00:00.000Z',
  status: 'planejado',
}

describe('lifecycle das referências da agenda', () => {
  it('não agenda uma marca cuja operação ou cliente pai não está ativo', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/agenda', payload: novoEvento })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Marca não encontrada' })
    const marcaCheck = query.mock.calls.find(([sql]) => String(sql).includes('FROM marcas m'))?.[0]
    expect(marcaCheck).toContain('LEFT JOIN clientes cl')
    expect(marcaCheck).toContain("= 'ativa'")
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agenda_eventos'))).toBe(false)
    await app.close()
  })

  it('não agenda cliente cancelado ou arquivado', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: { ...novoEvento, marca_id: undefined, cliente_id: marcaId },
    })

    expect(response.statusCode).toBe(404)
    const clienteCheck = query.mock.calls.find(([sql]) => String(sql).includes('FROM clientes'))?.[0]
    expect(clienteCheck).toContain("status IN ('ativo', 'inadimplente')")
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO marcas'))).toBe(false)
    await app.close()
  })

  it('recusa apresentadora inativa em novos turnos antes de substituir os vínculos', async () => {
    const evento = {
      id: eventoId,
      tenant_id: tenantId,
      tipo: 'live',
      status: 'confirmado',
      data_inicio: '2026-09-15T13:00:00.000Z',
      data_fim: '2026-09-15T14:00:00.000Z',
    }
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('FROM agenda_eventos WHERE id')) return { rows: [evento] }
      if (text.includes('FROM apresentadoras') && text.includes('ANY($1::uuid[])')) return { rows: [] }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/agenda/${eventoId}/apresentadoras`,
      payload: {
        apresentadoras: [{
          apresentadora_id: apresentadoraId,
          data_inicio: '2026-09-15T10:00:00-03:00',
          data_fim: '2026-09-15T11:00:00-03:00',
        }],
      },
    })

    expect(response.statusCode).toBe(404)
    const apresentadoraCheck = query.mock.calls.find(([sql]) => String(sql).includes('ANY($1::uuid[])'))?.[0]
    expect(apresentadoraCheck).toContain('ativo IS DISTINCT FROM FALSE')
    expect(apresentadoraCheck).toContain('arquivada IS NOT TRUE')
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM agenda_evento_apresentadoras'))).toBe(false)
    await app.close()
  })

  it('aceita o payload completo de evento histórico com vínculos hoje inativos', async () => {
    const historico = {
      id: eventoId,
      tenant_id: tenantId,
      tipo: 'live',
      status: 'concluido',
      marca_id: marcaId,
      apresentadora_id: apresentadoraId,
      data_inicio: '2025-09-15T13:00:00.000Z',
      data_fim: '2025-09-15T14:00:00.000Z',
      live_id: null,
    }
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('FROM agenda_eventos WHERE id') && text.includes('FOR UPDATE')) return { rows: [historico] }
      if (text.includes('SELECT cliente_id') && text.includes('FROM marcas')) return { rows: [{ cliente_id: '55555555-5555-4555-8555-555555555555' }] }
      if (text.includes('UPDATE agenda_eventos SET')) return { rows: [{ ...historico, observacoes: 'Registro conferido' }] }
      return { rows: [], rowCount: 0 }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/agenda/${eventoId}`,
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        cliente_id: '55555555-5555-4555-8555-555555555555',
        apresentadora_id: apresentadoraId,
        data_inicio: historico.data_inicio,
        data_fim: historico.data_fim,
        status: 'concluido',
        observacoes: 'Registro conferido',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM marcas m'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM apresentadoras'))).toBe(false)
    await app.close()
  })

  it('ainda recusa a troca do histórico por uma marca inativa', async () => {
    const historico = {
      id: eventoId, tenant_id: tenantId, tipo: 'live', status: 'concluido', marca_id: marcaId,
      data_inicio: '2025-09-15T13:00:00.000Z', data_fim: '2025-09-15T14:00:00.000Z', live_id: null,
    }
    const marcaInativa = '66666666-6666-4666-8666-666666666666'
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('FROM agenda_eventos WHERE id') && text.includes('FOR UPDATE')) return { rows: [historico] }
      if (text.includes('FROM marcas m')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const response = await app.inject({
      method: 'PATCH', url: `/v1/agenda/${eventoId}`,
      payload: { marca_id: marcaInativa, data_inicio: historico.data_inicio, data_fim: historico.data_fim },
    })

    expect(response.statusCode).toBe(404)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE agenda_eventos SET'))).toBe(false)
    await app.close()
  })

  it('mantém turno histórico inativo, mas rejeita uma nova apresentadora inativa', async () => {
    const evento = {
      id: eventoId, tenant_id: tenantId, tipo: 'live', status: 'concluido', apresentadora_id: apresentadoraId,
      data_inicio: '2025-09-15T13:00:00.000Z', data_fim: '2025-09-15T14:00:00.000Z',
    }
    const novaApresentadora = '77777777-7777-4777-8777-777777777777'
    const calls = []
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      calls.push(text)
      if (text.includes('FROM agenda_eventos WHERE id') && text.includes('FOR UPDATE')) return { rows: [evento] }
      if (text.includes('FROM agenda_evento_apresentadoras') && text.includes('SELECT apresentadora_id')) return { rows: [] }
      if (text.includes('FROM apresentadoras') && text.includes('ANY($1::uuid[])')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)
    const turnoHistorico = { apresentadora_id: apresentadoraId, data_inicio: '2025-09-15T10:00:00-03:00', data_fim: '2025-09-15T11:00:00-03:00' }

    const preservado = await app.inject({ method: 'PUT', url: `/v1/agenda/${eventoId}/apresentadoras`, payload: { apresentadoras: [turnoHistorico] } })
    expect(preservado.statusCode).toBe(200)
    expect(calls.some((sql) => sql.includes('ANY($1::uuid[])'))).toBe(false)

    const novo = await app.inject({
      method: 'PUT', url: `/v1/agenda/${eventoId}/apresentadoras`,
      payload: { apresentadoras: [{ ...turnoHistorico, apresentadora_id: novaApresentadora }] },
    })
    expect(novo.statusCode).toBe(404)
    expect(calls.filter((sql) => sql.includes('DELETE FROM agenda_evento_apresentadoras'))).toHaveLength(1)
    await app.close()
  })
})
