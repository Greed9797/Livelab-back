// Dois buracos que o revezamento abriu na agenda e que ficavam fora de teste:
//
// 1. Só o PUT de turnos consultava agenda_evento_apresentadoras. POST, PATCH e
//    GET /v1/agenda/conflitos olhavam apenas agenda_eventos.apresentadora_id — o espelho
//    ESCALAR, que guarda só a principal. A Bia que apresenta 16-18h dentro de um evento
//    cujo espelho é a Ana era invisível, e dava para reservá-la em duas cabines no mesmo
//    horário sem nenhum aviso. Duas lives semeiam v2 com ela e a comissão dobra.
//
// 2. O PATCH mexia na janela do evento sem olhar os turnos: o revezamento ficava
//    pendurado no horário antigo e o seed somava tempo que a live nunca teve.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const eventoId = '22222222-2222-4222-8222-222222222222'
const anaId = '33333333-3333-4333-8333-333333333333'
const marcaId = '66666666-6666-4666-8666-666666666666'
const outroEventoId = '55555555-5555-4555-8555-555555555555'

// Evento 14h-18h (America/Sao_Paulo), gravado em UTC.
const evento = {
  id: eventoId,
  tenant_id: tenantId,
  tipo: 'live',
  status: 'confirmado',
  cabine_id: null,
  marca_id: marcaId,
  apresentadora_id: anaId,
  recorrencia_origem_id: null,
  live_id: null,
  data_inicio: '2026-05-27T17:00:00.000Z',
  data_fim: '2026-05-27T21:00:00.000Z',
}

const turnoConflitante = {
  id: outroEventoId,
  tipo: 'live',
  marca_id: null,
  cabine_id: null,
  apresentadora_id: anaId,
  apresentadora_nome: 'Ana',
  cabine_numero: null,
  cabine_nome: null,
  data_inicio: '2026-05-27T18:00:00.000Z',
  data_fim: '2026-05-27T20:00:00.000Z',
  status: 'confirmado',
  entidade: 'apresentadora',
}

/**
 * @param turnosDoEvento linhas de agenda_evento_apresentadoras DESTE evento (para o PATCH)
 * @param conflitoPorTurno linhas devolvidas pela busca de conflito nos turnos ALHEIOS
 */
function buildApp({ turnosDoEvento = [], conflitoPorTurno = [] } = {}) {
  const app = Fastify()
  const calls = []

  const query = vi.fn(async (sql, params = []) => {
    calls.push({ sql: String(sql), params })
    const text = String(sql)
    if (text.includes('FROM marcas WHERE id')) return { rows: [{ id: marcaId }] }
    if (text.includes('FROM apresentadoras WHERE id')) return { rows: [{ id: anaId }] }
    if (text.includes('FROM agenda_eventos WHERE id')) return { rows: [evento] }
    if (text.includes('FROM agenda_evento_apresentadoras t')) return { rows: conflitoPorTurno }
    if (text.includes('FROM agenda_evento_apresentadoras\n')) return { rows: turnosDoEvento }
    if (text.includes('FROM agenda_eventos ae')) return { rows: [] }
    if (text.includes('UPDATE agenda_eventos SET')) return { rows: [{ ...evento }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })

  return { app, query, calls }
}

const turnoDoEvento = (hIniZ, hFimZ) => ({
  apresentadora_id: anaId,
  data_inicio: `2026-05-27T${hIniZ}:00:00.000Z`,
  data_fim: `2026-05-27T${hFimZ}:00:00.000Z`,
})

describe('conflito de apresentadora enxerga os turnos, não só o espelho', () => {
  it('GET /v1/agenda/conflitos devolve o evento em que ela é só turno', async () => {
    const { app } = buildApp({ conflitoPorTurno: [turnoConflitante] })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/agenda/conflitos?apresentadora_id=${anaId}&data_inicio=2026-05-27T18:00:00Z&data_fim=2026-05-27T20:00:00Z`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe(1)
    expect(res.json().conflitos[0].evento_id ?? res.json().conflitos[0].id).toBe(outroEventoId)
    await app.close()
  })

  it('POST /v1/agenda recusa 409 quando a apresentadora já tem turno na janela', async () => {
    const { app, calls } = buildApp({ conflitoPorTurno: [turnoConflitante] })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        apresentadora_id: anaId,
        data_inicio: '2026-05-27T18:00:00Z',
        data_fim: '2026-05-27T20:00:00Z',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AGENDA_CONFLICT')
    expect(calls.some((c) => c.sql.includes('INSERT INTO agenda_eventos'))).toBe(false)
    await app.close()
  })

  it('PATCH /v1/agenda/:id recusa 409 quando a apresentadora já tem turno na janela', async () => {
    const { app } = buildApp({ conflitoPorTurno: [turnoConflitante] })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agenda/${eventoId}`,
      payload: { apresentadora_id: anaId },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AGENDA_CONFLICT')
    await app.close()
  })
})

describe('PATCH /v1/agenda/:id — janela do evento x turnos', () => {
  it('desloca os turnos junto quando o evento é movido sem mudar de duração', async () => {
    // Evento 14-18 → 15-19 (SP). Turno 14-16 tem que virar 15-17, senão o seed some com
    // uma hora do rateio ou conta uma hora que a live nunca teve.
    const { app, calls } = buildApp({ turnosDoEvento: [turnoDoEvento('17', '19')] })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agenda/${eventoId}`,
      payload: { data_inicio: '2026-05-27T18:00:00Z', data_fim: '2026-05-27T22:00:00Z' },
    })

    expect(res.statusCode).toBe(200)
    const shift = calls.find((c) => c.sql.includes('UPDATE agenda_evento_apresentadoras'))
    expect(shift).toBeTruthy()
    expect(shift.params[2]).toBe(String(60 * 60 * 1000))
    await app.close()
  })

  it('recusa encurtar a janela deixando turno fora dela', async () => {
    // Evento 14-18 → 14-16, com turno 16-18 (SP) que ficaria pendurado fora.
    const { app, calls } = buildApp({ turnosDoEvento: [turnoDoEvento('19', '21')] })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agenda/${eventoId}`,
      payload: { data_fim: '2026-05-27T19:00:00.000Z' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('TURNOS_FORA_DA_JANELA')
    // Nada gravado: a recusa vem antes do UPDATE e a transação sofre ROLLBACK.
    expect(calls.some((c) => c.sql.includes('UPDATE agenda_eventos SET'))).toBe(false)
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK')
    await app.close()
  })

  it('recusa mover o evento para uma hora em que a apresentadora do turno já está ocupada', async () => {
    // O check de conflito do PATCH olha só o espelho escalar (a principal). Mover o
    // evento move o turno de todo mundo para um horário que ninguém validou.
    const { app, calls } = buildApp({
      turnosDoEvento: [turnoDoEvento('17', '19')],
      conflitoPorTurno: [turnoConflitante],
    })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agenda/${eventoId}`,
      payload: { data_inicio: '2026-05-27T18:00:00Z', data_fim: '2026-05-27T22:00:00Z' },
    })

    expect(res.statusCode).toBe(409)
    expect(calls.some((c) => c.sql.includes('UPDATE agenda_evento_apresentadoras'))).toBe(false)
    await app.close()
  })

  it('aceita esticar a janela: os turnos continuam dentro dela', async () => {
    const { app, calls } = buildApp({ turnosDoEvento: [turnoDoEvento('17', '19')] })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agenda/${eventoId}`,
      payload: { data_fim: '2026-05-27T23:00:00.000Z' },
    })

    expect(res.statusCode).toBe(200)
    expect(calls.some((c) => c.sql.includes('UPDATE agenda_evento_apresentadoras'))).toBe(false)
    await app.close()
  })
})
