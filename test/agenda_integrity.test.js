import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const cabineId = '33333333-3333-4333-8333-333333333333'
const cabineB = '44444444-4444-4444-8444-444444444444'
const eventoId = '55555555-5555-4555-8555-555555555555'
const siblingId = '66666666-6666-4666-8666-666666666666'
const occupiedId = '77777777-7777-4777-8777-777777777777'
const liveId = '88888888-8888-4888-8888-888888888888'
const anaId = '99999999-9999-4999-8999-999999999999'
const biaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function buildApp(query) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    request.user ??= { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('audit', { log: vi.fn(async () => {}) })
  return app
}

function tx(sql) {
  return sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
}

describe('POST /v1/agenda — planejado bloqueia a cabine', () => {
  it('o segundo planejado sobreposto na mesma cabine é 409', async () => {
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (tx(text)) return { rows: [] }
      if (text.includes('FROM marcas')) return { rows: [{ id: marcaId }] }
      if (text.includes('FROM cabines')) return { rows: [{ id: cabineId }] }
      if (text.includes('FROM agenda_eventos ae')) {
        return {
          rows: [{
            id: occupiedId,
            tipo: 'live',
            entidade: 'cabine',
            cabine_id: cabineId,
            status: 'planejado',
            data_inicio: '2026-09-15T13:00:00.000Z',
            data_fim: '2026-09-15T15:00:00.000Z',
          }],
        }
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        cabine_id: cabineId,
        status: 'planejado',
        data_inicio: '2026-09-15T14:00:00.000Z',
        data_fim: '2026-09-15T16:00:00.000Z',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AGENDA_CONFLICT')
    const conflict = query.mock.calls.find(([sql]) => String(sql).includes('FROM agenda_eventos ae'))
    expect(conflict[1][3]).toEqual(['planejado', 'confirmado', 'ao_vivo'])
    expect(conflict[1][3]).not.toContain('cancelado')
    expect(conflict[1][3]).not.toContain('concluido')
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agenda_eventos'))).toBe(false)
    expect(query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK')
    await app.close()
  })

  it('falha no segundo insert da recorrência desfaz a série inteira', async () => {
    let inserts = 0
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (tx(text)) return { rows: [] }
      if (text.includes('FROM marcas')) return { rows: [{ id: marcaId }] }
      if (text.includes('INSERT INTO agenda_eventos')) {
        inserts += 1
        if (inserts >= 2) throw new Error('forced insert failure')
        return { rows: [{ id: eventoId }] }
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        status: 'planejado',
        data_inicio: '2026-09-15T15:00:00.000Z',
        data_fim: '2026-09-15T16:00:00.000Z',
        recorrencia: { frequencia: 'diaria', ate: '2026-09-17', total_ocorrencias: 2 },
      },
    })

    expect(res.statusCode).toBe(500)
    expect(inserts).toBeGreaterThanOrEqual(2)
    const sqls = query.mock.calls.map(([sql]) => sql)
    expect(sqls).toContain('BEGIN')
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    await app.close()
  })
})

describe('PATCH /v1/agenda — série não invade slot ocupado', () => {
  it('409 e não move as outras ocorrências', async () => {
    const anchor = {
      id: eventoId,
      tenant_id: tenantId,
      tipo: 'live',
      status: 'planejado',
      marca_id: marcaId,
      cabine_id: cabineId,
      apresentadora_id: null,
      recorrencia_origem_id: null,
      live_id: null,
      data_inicio: '2026-09-15T13:00:00.000Z',
      data_fim: '2026-09-15T14:00:00.000Z',
    }
    const sibling = {
      id: siblingId,
      tipo: 'live',
      status: 'planejado',
      marca_id: marcaId,
      cabine_id: cabineId,
      apresentadora_id: null,
      data_inicio: '2026-09-16T13:00:00.000Z',
      data_fim: '2026-09-16T14:00:00.000Z',
    }
    const query = vi.fn(async (sql, params = []) => {
      const text = String(sql)
      if (tx(text)) return { rows: [] }
      if (text.includes('FROM agenda_eventos WHERE id') && text.includes('FOR UPDATE')) return { rows: [anchor] }
      if (text.includes('recorrencia_origem_id')) return { rows: [sibling] }
      if (text.includes('FROM cabines')) return { rows: [{ id: cabineB }] }
      if (text.includes('FROM agenda_eventos ae')) {
        if (String(params[1]).includes('2026-09-16')) {
          return {
            rows: [{
              id: occupiedId,
              tipo: 'live',
              entidade: 'cabine',
              cabine_id: cabineB,
              status: 'confirmado',
              data_inicio: sibling.data_inicio,
              data_fim: sibling.data_fim,
            }],
          }
        }
        return { rows: [] }
      }
      return { rows: [], rowCount: 0 }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agenda/${eventoId}`,
      payload: { cabine_id: cabineB, modo_recorrencia: 'todos' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AGENDA_CONFLICT')
    const sqls = query.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((sql) => sql.includes('UPDATE agenda_eventos SET'))).toBe(false)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    await app.close()
  })
})

describe('DELETE /v1/agenda — ao_vivo com live', () => {
  it('409 e não altera a linha', async () => {
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('FROM agenda_eventos WHERE id')) {
        return { rows: [{ id: eventoId, status: 'ao_vivo', live_id: liveId, tenant_id: tenantId }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({ method: 'DELETE', url: `/v1/agenda/${eventoId}` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'Encerre a live antes de cancelar a agenda.' })
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE agenda_eventos'))).toBe(false)
    await app.close()
  })

  it('cancela planejado', async () => {
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('FROM agenda_eventos WHERE id')) {
        return { rows: [{ id: eventoId, status: 'planejado', live_id: null }] }
      }
      return { rows: [], rowCount: 1 }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({ method: 'DELETE', url: `/v1/agenda/${eventoId}` })
    expect(res.statusCode).toBe(204)
    const update = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE agenda_eventos'))
    expect(update[0]).toContain("status = 'cancelado'")
    await app.close()
  })
})

describe('PUT /v1/agenda/:id/apresentadoras — live aberta', () => {
  const evento = {
    id: eventoId,
    tenant_id: tenantId,
    tipo: 'live',
    status: 'ao_vivo',
    live_id: liveId,
    cabine_id: cabineId,
    marca_id: marcaId,
    apresentadora_id: anaId,
    data_inicio: '2026-09-15T13:00:00.000Z',
    data_fim: '2026-09-15T17:00:00.000Z',
  }
  const turnos = [
    { apresentadora_id: biaId, data_inicio: '2026-09-15T13:00:00.000Z', data_fim: '2026-09-15T15:00:00.000Z' },
    { apresentadora_id: anaId, data_inicio: '2026-09-15T15:00:00.000Z', data_fim: '2026-09-15T17:00:00.000Z' },
  ]

  it('resemeia v2 da live em andamento e não mexe em comissão', async () => {
    const inserted = []
    const query = vi.fn(async (sql, params = []) => {
      const text = String(sql)
      if (tx(text) || text.startsWith('SAVEPOINT') || text.startsWith('RELEASE')) return { rows: [] }
      if (text.includes('FROM agenda_eventos WHERE id')) return { rows: [evento] }
      if (text.includes('FROM apresentadoras') && text.includes('ANY')) return { rows: [{ id: biaId }] }
      if (text.includes('FROM agenda_eventos ae') || text.includes('FROM agenda_evento_apresentadoras t')) return { rows: [] }
      if (text.includes('FROM lives') && text.includes("status = 'em_andamento'")) return { rows: [{ id: liveId }] }
      if (text.includes('FROM agenda_evento_apresentadoras') && text.includes('ORDER BY')) return { rows: turnos }
      if (text.includes('FROM agenda_evento_apresentadoras aea')) {
        return { rows: turnos.map((turno) => ({ ...turno, apresentadora_nome: 'Nome' })) }
      }
      if (text.includes('INSERT INTO live_apresentadoras_v2')) {
        inserted.push(params)
        return { rows: [] }
      }
      return { rows: [], rowCount: 1 }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/agenda/${eventoId}/apresentadoras`,
      payload: { apresentadoras: turnos },
    })

    expect(res.statusCode).toBe(200)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM live_apresentadoras_v2'))).toBe(true)
    expect(inserted.map((params) => params[2]).sort()).toEqual([anaId, biaId].sort())
    expect(query.mock.calls.some(([sql]) => /vendas_atribuidas|comissao/i.test(String(sql)))).toBe(false)
    await app.close()
  })

  it('não semeia live que não está em andamento', async () => {
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (tx(text) || text.startsWith('SAVEPOINT') || text.startsWith('RELEASE')) return { rows: [] }
      if (text.includes('FROM agenda_eventos WHERE id')) return { rows: [evento] }
      if (text.includes('FROM apresentadoras') && text.includes('ANY')) return { rows: [{ id: biaId }] }
      if (text.includes('FROM lives') && text.includes("status = 'em_andamento'")) return { rows: [] }
      if (text.includes('FROM agenda_evento_apresentadoras aea')) return { rows: [] }
      return { rows: [], rowCount: 1 }
    })
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/agenda/${eventoId}/apresentadoras`,
      payload: { apresentadoras: turnos },
    })

    expect(res.statusCode).toBe(200)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM live_apresentadoras_v2'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO live_apresentadoras_v2'))).toBe(false)
    await app.close()
  })
})

describe('GET /v1/agenda — teto e uuid', () => {
  it('sinaliza truncated e devolve no máximo 500', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ id: `evt-${index}` }))
    const query = vi.fn(async () => ({ rows }))
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/agenda' })
    expect(res.statusCode).toBe(200)
    expect(res.json().truncated).toBe(true)
    expect(res.json().eventos).toHaveLength(500)
    expect(String(query.mock.calls.at(-1)[0])).toContain('LIMIT 501')
    await app.close()
  })

  it('truncated false quando cabe no teto', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'evt-1' }] }))
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/agenda' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ truncated: false, eventos: [{ id: 'evt-1' }] })
    await app.close()
  })

  it('cabine_id inválido é 400 antes do cast', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const app = buildApp(query)
    await app.register(agendaRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/agenda?cabine_id=not-a-uuid' })
    expect(res.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })
})
