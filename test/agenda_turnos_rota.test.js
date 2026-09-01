// PUT /v1/agenda/:id/apresentadoras — turnos de revezamento (replace-all).
//
// A rota é sub-rota de propósito: o PATCH monta o UPDATE por reflexão sobre os campos
// do corpo, então `apresentadoras` viraria uma coluna inexistente. Aqui a cobertura é
// do que a rota promete: janela do evento, tenant da apresentadora, conflito por turno
// (sem contar o mesmo evento duas vezes) e o espelho escalar que o autostart lê.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const eventoId = '22222222-2222-4222-8222-222222222222'
const anaId = '33333333-3333-4333-8333-333333333333'
const biaId = '44444444-4444-4444-8444-444444444444'
const outroEventoId = '55555555-5555-4555-8555-555555555555'

// Evento 14h-18h (America/Sao_Paulo) — o banco devolve em UTC.
const evento = {
  id: eventoId,
  tenant_id: tenantId,
  tipo: 'live',
  status: 'confirmado',
  cabine_id: null,
  apresentadora_id: anaId,
  data_inicio: '2026-05-27T17:00:00.000Z',
  data_fim: '2026-05-27T21:00:00.000Z',
}

function conflitoRow(overrides = {}) {
  return {
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
    ...overrides,
  }
}

function buildApp({ handlers = {}, eventoRow = evento, apresentadorasEncontradas } = {}) {
  const app = Fastify()
  const calls = []

  const query = vi.fn(async (sql, params = []) => {
    calls.push({ sql: String(sql), params })
    const text = String(sql)
    if (text.includes('FROM agenda_eventos WHERE id')) return { rows: eventoRow ? [eventoRow] : [] }
    if (text.includes('FROM apresentadoras WHERE id = ANY')) {
      const ids = apresentadorasEncontradas ?? params[0]
      return { rows: ids.map((id) => ({ id })) }
    }
    if (text.includes('FROM agenda_eventos ae')) return { rows: handlers.espelho?.() ?? [] }
    if (text.includes('FROM agenda_evento_apresentadoras t')) return { rows: handlers.turnos?.() ?? [] }
    if (text.includes('FROM agenda_evento_apresentadoras aea')) return { rows: handlers.gravados?.() ?? [] }
    return { rows: [] }
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

function put(app, apresentadoras, id = eventoId) {
  return app.inject({
    method: 'PUT',
    url: `/v1/agenda/${id}/apresentadoras`,
    payload: { apresentadoras },
  })
}

const turnoAna = { apresentadora_id: anaId, data_inicio: '2026-05-27T14:00:00-03:00', data_fim: '2026-05-27T15:00:00-03:00' }
const turnoBia = { apresentadora_id: biaId, data_inicio: '2026-05-27T15:00:00-03:00', data_fim: '2026-05-27T18:00:00-03:00' }

describe('PUT /v1/agenda/:id/apresentadoras', () => {
  it('recusa turno fora da janela do evento com o horário na mensagem', async () => {
    const { app, calls } = buildApp()
    await app.register(agendaRoutes)

    const res = await put(app, [
      { apresentadora_id: anaId, data_inicio: '2026-05-27T13:00:00-03:00', data_fim: '2026-05-27T15:00:00-03:00' },
    ])

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('14:00')
    expect(res.json().error).toContain('18:00')
    expect(calls.some((c) => c.sql.includes('INSERT INTO agenda_evento_apresentadoras'))).toBe(false)
    await app.close()
  })

  it('recusa o mesmo par (apresentadora, início) duas vezes em vez de estourar no UNIQUE', async () => {
    const { app, calls } = buildApp()
    await app.register(agendaRoutes)

    const res = await put(app, [turnoAna, { ...turnoAna, data_fim: '2026-05-27T16:00:00-03:00' }])

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Turno repetido para a mesma apresentadora')
    expect(calls.some((c) => c.sql.includes('DELETE FROM agenda_evento_apresentadoras'))).toBe(false)
    await app.close()
  })

  it('devolve 404 e não grava nada quando a apresentadora é de outro tenant', async () => {
    const { app, calls } = buildApp({ apresentadorasEncontradas: [anaId] })
    await app.register(agendaRoutes)

    const res = await put(app, [turnoAna, turnoBia])

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Apresentadora não encontrada')
    expect(calls.some((c) => c.sql.includes('INSERT INTO agenda_evento_apresentadoras'))).toBe(false)
    expect(calls.some((c) => c.sql.includes('DELETE FROM agenda_evento_apresentadoras'))).toBe(false)
    await app.close()
  })

  it('devolve 404 quando o evento não existe (rota existe, evento não) ', async () => {
    const { app } = buildApp({ eventoRow: null })
    await app.register(agendaRoutes)

    const res = await put(app, [])

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Evento não encontrado')
    await app.close()
  })

  it('devolve 409 com entidade=apresentadora quando o turno colide com outro evento', async () => {
    const { app, calls } = buildApp({ handlers: { turnos: () => [conflitoRow()] } })
    await app.register(agendaRoutes)

    const res = await put(app, [turnoAna, turnoBia])

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.code).toBe('AGENDA_CONFLICT')
    expect(body.conflitos[0].entidade).toBe('apresentadora')
    expect(body.conflitos[0].evento_id).toBe(outroEventoId)
    expect(calls.some((c) => c.sql.includes('DELETE FROM agenda_evento_apresentadoras'))).toBe(false)
    await app.close()
  })

  it('não considera evento planejado como conflito nos dois ramos da checagem', async () => {
    const { app, calls } = buildApp()
    await app.register(agendaRoutes)

    const res = await put(app, [turnoAna, turnoBia])
    expect(res.statusCode).toBe(200)

    const espelho = calls.find((c) => c.sql.includes('FROM agenda_eventos ae'))
    const turnos = calls.find((c) => c.sql.includes('FROM agenda_evento_apresentadoras t'))
    expect(espelho.params[3]).toEqual(['confirmado', 'ao_vivo'])
    expect(turnos.params[4]).toEqual(['confirmado', 'ao_vivo'])
    await app.close()
  })

  it('conta uma vez só o evento que aparece pelo espelho e pelo turno', async () => {
    const { app } = buildApp({
      handlers: { espelho: () => [conflitoRow()], turnos: () => [conflitoRow()] },
    })
    await app.register(agendaRoutes)

    const res = await put(app, [turnoAna, turnoBia])

    expect(res.statusCode).toBe(409)
    expect(res.json().conflitos).toHaveLength(1)
    await app.close()
  })

  it('grava um INSERT por turno e espelha quem tem mais tempo em agenda_eventos', async () => {
    const { app, calls } = buildApp({
      handlers: {
        gravados: () => [
          { apresentadora_id: anaId, apresentadora_nome: 'Ana', data_inicio: '2026-05-27T17:00:00.000Z', data_fim: '2026-05-27T18:00:00.000Z' },
          { apresentadora_id: biaId, apresentadora_nome: 'Bia', data_inicio: '2026-05-27T18:00:00.000Z', data_fim: '2026-05-27T21:00:00.000Z' },
        ],
      },
    })
    await app.register(agendaRoutes)

    const res = await put(app, [turnoAna, turnoBia])

    expect(res.statusCode).toBe(200)
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO agenda_evento_apresentadoras'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0].params).toEqual([tenantId, eventoId, anaId, turnoAna.data_inicio, turnoAna.data_fim])

    // Bia apresenta 3h contra 1h da Ana — o espelho tem que ser a Bia, a mesma regra
    // que seedRateioPlanejado usa para eleger a principal quando a live abrir.
    const espelho = calls.find((c) => c.sql.includes('UPDATE agenda_eventos SET apresentadora_id'))
    expect(espelho.params[0]).toBe(biaId)

    expect(res.json()).toMatchObject({ evento_id: eventoId })
    expect(res.json().apresentadoras).toHaveLength(2)
    await app.close()
  })

  // ANTES este teste afirmava `espelho.params[0]).toBeNull()` — fixava o bug em vez do
  // contrato. O front sai do revezamento promovendo a apresentadora para o campo escalar
  // (PATCH) e só então manda o PUT vazio; zerar o espelho aqui apagava justamente quem o
  // operador acabou de escolher, a live abria com apresentador_id NULL e a comissão inteira
  // caía numa linha de vendas_atribuidas sem dono. Quem apaga o escalar é o PATCH.
  it('array vazio apaga os turnos e NÃO toca no espelho', async () => {
    const { app, calls } = buildApp()
    await app.register(agendaRoutes)

    const res = await put(app, [])

    expect(res.statusCode).toBe(200)
    expect(calls.some((c) => c.sql.includes('DELETE FROM agenda_evento_apresentadoras'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('INSERT INTO agenda_evento_apresentadoras'))).toBe(false)
    expect(calls.some((c) => c.sql.includes('UPDATE agenda_eventos SET apresentadora_id'))).toBe(false)
    expect(res.json()).toEqual({ evento_id: eventoId, apresentadoras: [] })
    await app.close()
  })

  it('recusa dois turnos no MESMO INSTANTE escritos com offsets diferentes', async () => {
    const { app, calls } = buildApp()
    await app.register(agendaRoutes)

    // 14:00-03:00 e 17:00Z são o mesmo instante — a UNIQUE do banco compara timestamptz.
    // Comparando texto cru, os dois passavam e o segundo INSERT estourava 23505 (500) com
    // o DELETE já feito.
    const res = await put(app, [
      turnoAna,
      { apresentadora_id: anaId, data_inicio: '2026-05-27T17:00:00.000Z', data_fim: '2026-05-27T16:00:00-03:00' },
    ])

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Turno repetido para a mesma apresentadora')
    expect(calls.some((c) => c.sql.includes('DELETE FROM agenda_evento_apresentadoras'))).toBe(false)
    await app.close()
  })

  // Sem BEGIN/COMMIT o replace-all vira DELETE + N INSERT + UPDATE em commits separados:
  // uma queda no meio apaga o revezamento e o `FOR UPDATE` do evento não segura lock nenhum
  // (withTenant é autocommit).
  it('escreve o replace-all dentro de uma transação', async () => {
    const { app, calls } = buildApp({
      handlers: { gravados: () => [] },
    })
    await app.register(agendaRoutes)

    const res = await put(app, [turnoAna, turnoBia])
    expect(res.statusCode).toBe(200)

    const sqls = calls.map((c) => c.sql)
    const begin = sqls.indexOf('BEGIN')
    const commit = sqls.indexOf('COMMIT')
    const del = sqls.findIndex((s) => s.includes('DELETE FROM agenda_evento_apresentadoras'))
    const lock = sqls.findIndex((s) => s.includes('FROM agenda_eventos WHERE id') && s.includes('FOR UPDATE'))

    expect(begin).toBeGreaterThanOrEqual(0)
    expect(begin).toBeLessThan(lock)
    expect(lock).toBeLessThan(del)
    expect(del).toBeLessThan(commit)
    await app.close()
  })

  it('faz ROLLBACK e não commita quando o conflito barra a escrita', async () => {
    const { app, calls } = buildApp({ handlers: { turnos: () => [conflitoRow()] } })
    await app.register(agendaRoutes)

    const res = await put(app, [turnoAna, turnoBia])
    expect(res.statusCode).toBe(409)

    const sqls = calls.map((c) => c.sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    await app.close()
  })

  it('faz ROLLBACK quando o evento não existe', async () => {
    const { app, calls } = buildApp({ eventoRow: null })
    await app.register(agendaRoutes)

    const res = await put(app, [])
    expect(res.statusCode).toBe(404)
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK')
    await app.close()
  })
})

describe('GET /v1/agenda — turnos vêm junto sem mexer no que já existia', () => {
  it('agrega os turnos por LATERAL e mantém apresentadora_nome do espelho', async () => {
    const { app, calls } = buildApp()
    await app.register(agendaRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/agenda' })
    expect(res.statusCode).toBe(200)

    const sql = calls.find((c) => c.sql.includes('FROM agenda_eventos ae')).sql
    expect(sql).toContain('a.nome AS apresentadora_nome')
    expect(sql).toContain("COALESCE(t.turnos, '[]'::json) AS apresentadoras")
    expect(sql).toContain('FROM agenda_evento_apresentadoras aea')
    await app.close()
  })
})
