// Job de auto-start: agenda_eventos planejados viram ao_vivo quando NOW
// está no slot. Lock pessimista evita race com POST /v1/lives manual.

import { describe, expect, it, vi } from 'vitest'

import { runAgendaAutostartTick } from '../src/jobs/agenda_autostart.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const eventId = '22222222-2222-4222-8222-222222222222'
const cabineId = '33333333-3333-4333-8333-333333333333'
const marcaId = '44444444-4444-4444-8444-444444444444'
const apresentadoraId = '55555555-5555-4555-8555-555555555555'
const newLiveId = '66666666-6666-4666-8666-666666666666'
const clienteId = '77777777-7777-4777-8777-777777777777'
const apresentadorUserId = '88888888-8888-4888-8888-888888888888'

function makeApp({ candidates, clientQueryMock }) {
  const release = vi.fn()
  const clientQuery = clientQueryMock ?? vi.fn().mockResolvedValue({ rows: [] })
  const poolQuery = vi.fn().mockResolvedValue({ rows: candidates ?? [] })
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      query: poolQuery,
      pool: {
        connect: vi.fn(async () => ({ query: clientQuery, release })),
      },
    },
    _release: release,
    _clientQuery: clientQuery,
    _poolQuery: poolQuery,
  }
}

describe('agenda_autostart job', () => {
  it('inicia live para evento planejado vencido', async () => {
    const candidate = {
      id: eventId,
      tenant_id: tenantId,
      cabine_id: cabineId,
      marca_id: marcaId,
      apresentadora_id: apresentadoraId,
      data_inicio: new Date(Date.now() - 5 * 60_000).toISOString(),
      data_fim: new Date(Date.now() + 60 * 60_000).toISOString(),
      minutos_atraso: 5,
    }

    let callIdx = 0
    const clientQuery = vi.fn(async (sql) => {
      callIdx += 1
      const s = String(sql)
      if (s.includes('SELECT id, live_id, cabine_id') && s.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: eventId,
            live_id: null,
            cabine_id: cabineId,
            marca_id: marcaId,
            apresentadora_id: apresentadoraId,
            data_fim: candidate.data_fim,
          }],
        }
      }
      if (s.includes('FROM cabines') && s.includes('FOR UPDATE')) {
        return { rows: [{ id: cabineId, status: 'disponivel', ativo: true, live_atual_id: null, contrato_id: null }] }
      }
      if (s.includes('FROM marcas')) return { rows: [{ cliente_id: clienteId }] }
      if (s.includes('FROM apresentadoras')) return { rows: [{ user_id: apresentadorUserId }] }
      if (s.includes('INSERT INTO lives')) return { rows: [{ id: newLiveId }] }
      return { rows: [] }
    })

    const app = makeApp({ candidates: [candidate], clientQueryMock: clientQuery })
    const result = await runAgendaAutostartTick(app)

    expect(result).toMatchObject({ started: 1, errors: 0 })

    const insertCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO lives')
    )
    expect(insertCall).toBeTruthy()
    expect(insertCall[1]).toContain(tenantId)
    expect(insertCall[1]).toContain(cabineId)

    const updateAgendaCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agenda_eventos') && String(sql).includes("status = 'ao_vivo'")
    )
    expect(updateAgendaCall).toBeTruthy()

    const updateCabineCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE cabines') && String(sql).includes("status = 'ao_vivo'")
    )
    expect(updateCabineCall).toBeTruthy()

    expect(app._release).toHaveBeenCalled()
  })

  it('pula evento stale (>1h atraso)', async () => {
    const candidate = {
      id: eventId,
      tenant_id: tenantId,
      cabine_id: cabineId,
      data_inicio: new Date(Date.now() - 90 * 60_000).toISOString(),
      data_fim: new Date(Date.now() + 60_000).toISOString(),
      minutos_atraso: 90,
    }
    const app = makeApp({ candidates: [candidate] })
    const result = await runAgendaAutostartTick(app)
    expect(result.stale).toBe(1)
    expect(result.started).toBe(0)
  })

  it('pula evento quando cabine já tem live ativa', async () => {
    const candidate = {
      id: eventId,
      tenant_id: tenantId,
      cabine_id: cabineId,
      data_inicio: new Date(Date.now() - 5 * 60_000).toISOString(),
      data_fim: new Date(Date.now() + 60_000).toISOString(),
      minutos_atraso: 5,
    }
    const clientQuery = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('SELECT id, live_id') && s.includes('FOR UPDATE')) {
        return { rows: [{ id: eventId, live_id: null, cabine_id: cabineId, marca_id: null, apresentadora_id: null, data_fim: candidate.data_fim }] }
      }
      if (s.includes('FROM cabines') && s.includes('FOR UPDATE')) {
        return { rows: [{ id: cabineId, status: 'ao_vivo', ativo: true, live_atual_id: 'outra-live-id', contrato_id: null }] }
      }
      return { rows: [] }
    })
    const app = makeApp({ candidates: [candidate], clientQueryMock: clientQuery })
    const result = await runAgendaAutostartTick(app)
    expect(result.started).toBe(0)
    expect(result.errors).toBe(0)
    const insertCall = clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO lives'))
    expect(insertCall).toBeFalsy()
  })

  it('pula quando live_id já está preenchido (race com manual start)', async () => {
    const candidate = {
      id: eventId,
      tenant_id: tenantId,
      cabine_id: cabineId,
      data_inicio: new Date(Date.now() - 5 * 60_000).toISOString(),
      data_fim: new Date(Date.now() + 60_000).toISOString(),
      minutos_atraso: 5,
    }
    const clientQuery = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('SELECT id, live_id') && s.includes('FOR UPDATE')) {
        return { rows: [{ id: eventId, live_id: 'live-criada-pelo-manual', cabine_id: cabineId, marca_id: null, apresentadora_id: null, data_fim: candidate.data_fim }] }
      }
      return { rows: [] }
    })
    const app = makeApp({ candidates: [candidate], clientQueryMock: clientQuery })
    const result = await runAgendaAutostartTick(app)
    expect(result.started).toBe(0)
    expect(result.errors).toBe(0)
  })
})
