import { describe, expect, it, vi } from 'vitest'

import { syncAgendaEventForLive } from '../src/lib/live-agenda-sync.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveId = '22222222-2222-4222-8222-222222222222'
const cabineId = '33333333-3333-4333-8333-333333333333'
const marcaA = '44444444-4444-4444-8444-444444444444'
const marcaB = '55555555-5555-4555-8555-555555555555'
const eventA = '66666666-6666-4666-8666-666666666666'
const eventB = '77777777-7777-4777-8777-777777777777'

function baseInput(overrides = {}) {
  return {
    tenantId,
    liveId,
    agendaEventoId: null,
    cabineId,
    marcaId: marcaA,
    apresentadoraId: null,
    dataInicio: '2026-09-15T13:00:00.000Z',
    dataFim: '2026-09-15T17:00:00.000Z',
    status: 'encerrada',
    observacoes: 'resumo',
    criadoPor: null,
    ...overrides,
  }
}

describe('syncAgendaEventForLive', () => {
  it('não atualiza vizinhos quando há mais de um overlap de cabine e marca', async () => {
    const query = vi.fn(async (sql) => {
      if (String(sql).includes('FROM agenda_eventos ae')) {
        return { rows: [{ id: eventA }, { id: eventB }] }
      }
      return { rows: [] }
    })

    const id = await syncAgendaEventForLive({ query }, baseInput())
    expect(id).toBeNull()
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE agenda_eventos'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agenda_eventos'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE lives'))).toBe(false)
  })

  it('não atualiza o evento da outra marca no mesmo horário e cabine', async () => {
    const query = vi.fn(async (sql, params = []) => {
      const text = String(sql)
      if (text.includes('FROM agenda_eventos ae')) {
        expect(params[1]).toBe(marcaA)
        expect(params[2]).toBe(cabineId)
        return { rows: [{ id: eventA }] }
      }
      if (text.includes('UPDATE agenda_eventos')) return { rows: [{ id: params[0] }] }
      return { rows: [] }
    })

    const id = await syncAgendaEventForLive({ query }, baseInput())
    expect(id).toBe(eventA)
    const update = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE agenda_eventos'))
    expect(update[1][0]).toBe(eventA)
    expect(update[1]).not.toContain(eventB)
    expect(update[0]).toContain("COALESCE(NULLIF(observacoes, ''), $10)")
  })

  it('id explícito só atualiza quando cabine e marca batem', async () => {
    const mismatch = vi.fn(async () => ({
      rows: [{ id: eventA, cabine_id: cabineId, marca_id: marcaB }],
    }))
    const missed = await syncAgendaEventForLive({ query: mismatch }, baseInput({ agendaEventoId: eventA }))
    expect(missed).toBeNull()
    expect(mismatch.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false)

    const match = vi.fn(async (sql, params = []) => {
      const text = String(sql)
      if (text.includes('SELECT id, cabine_id, marca_id')) {
        return { rows: [{ id: eventA, cabine_id: cabineId, marca_id: marcaA }] }
      }
      if (text.includes('UPDATE agenda_eventos')) return { rows: [{ id: params[0] }] }
      return { rows: [] }
    })
    const linked = await syncAgendaEventForLive({ query: match }, baseInput({ agendaEventoId: eventA }))
    expect(linked).toBe(eventA)
    const update = match.mock.calls.find(([sql]) => String(sql).includes('UPDATE agenda_eventos'))
    expect(update[1][0]).toBe(eventA)
  })
})
