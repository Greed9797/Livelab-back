import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import {
  buildAcompanhamento,
  intervalUnionMinutes,
} from '../src/lib/grade-acompanhamento.js'
import { gradeRoutes } from '../src/routes/grade.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const cabine1 = '00000000-0000-4000-8000-000000000001'
const cabine2 = '00000000-0000-4000-8000-000000000002'
const evento1 = '00000000-0000-4000-8000-000000000011'
const evento2 = '00000000-0000-4000-8000-000000000012'
const live1 = '00000000-0000-4000-8000-000000000021'

describe('acompanhamento da grade — interpretação conservadora', () => {
  it('faz união de intervalos sobrepostos e corta reconexões na janela do dia', () => {
    expect(intervalUnionMinutes([
      ['2026-07-17T10:00:00.000Z', '2026-07-17T13:00:00.000Z'],
      ['2026-07-17T12:30:00.000Z', '2026-07-17T14:00:00.000Z'],
      ['2026-07-18T02:30:00.000Z', '2026-07-18T04:30:00.000Z'],
    ], '2026-07-17T03:00:00.000Z', '2026-07-18T03:00:00.000Z')).toBe(270)
  })

  it('só confirma vínculo por ID; overlap ambíguo permanece pendente', () => {
    const result = buildAcompanhamento({
      data: '2026-07-17',
      dayStart: '2026-07-17T03:00:00.000Z',
      dayEnd: '2026-07-18T03:00:00.000Z',
      cabines: [{ id: cabine1, numero: 1, nome: null, status: 'disponivel' }],
      agenda: [
        { id: evento1, cabine_id: cabine1, tipo: 'live', status: 'confirmado', marca_id: 'marca-1', marca_nome: 'Marca 1', data_inicio: '2026-07-17T11:00:00.000Z', data_fim: '2026-07-17T14:00:00.000Z', live_id: null },
        { id: evento2, cabine_id: cabine1, tipo: 'live', status: 'cancelado', marca_id: 'marca-2', marca_nome: 'Marca 2', data_inicio: '2026-07-17T15:00:00.000Z', data_fim: '2026-07-17T18:00:00.000Z', live_id: null },
      ],
      lives: [
        { id: live1, cabine_id: cabine1, status: 'encerrada', marca_id: 'marca-1', marca_nome: 'Marca 1', iniciado_em: '2026-07-17T11:05:00.000Z', encerrado_em: '2026-07-17T13:55:00.000Z', agenda_evento_id: null },
      ],
    })

    expect(result.cabines[0].planejamentos).toEqual([
      expect.objectContaining({ id: evento1, situacao: 'vinculacao_pendente', live_ids: [], live_candidata_ids: [live1] }),
      expect.objectContaining({ id: evento2, situacao: 'cancelada' }),
    ])
    expect(result.cabines[0].execucoes_sem_reserva).toEqual([
      expect.objectContaining({ id: live1, situacao: 'vinculacao_pendente', agenda_candidata_ids: [evento1] }),
    ])
  })

  it('agrega reconexões confirmadas sem dobrar minutos e mantém manutenção explícita', () => {
    const result = buildAcompanhamento({
      data: '2026-07-17',
      dayStart: '2026-07-17T03:00:00.000Z',
      dayEnd: '2026-07-18T03:00:00.000Z',
      cabines: [{ id: cabine1, numero: 1, nome: null, status: 'manutencao' }],
      agenda: [
        { id: evento1, cabine_id: cabine1, tipo: 'live', status: 'confirmado', marca_id: 'marca-1', marca_nome: 'Marca 1', data_inicio: '2026-07-17T11:00:00.000Z', data_fim: '2026-07-17T14:00:00.000Z', live_id: live1 },
        { id: evento2, cabine_id: cabine1, tipo: 'bloqueio_manutencao', status: 'confirmado', marca_id: null, marca_nome: null, data_inicio: '2026-07-17T15:00:00.000Z', data_fim: '2026-07-17T18:00:00.000Z', live_id: null },
      ],
      lives: [
        { id: live1, cabine_id: cabine1, status: 'encerrada', marca_id: 'marca-1', iniciado_em: '2026-07-17T11:00:00.000Z', encerrado_em: '2026-07-17T13:00:00.000Z', agenda_evento_id: evento1 },
        { id: 'live-2', cabine_id: cabine1, status: 'encerrada', marca_id: 'marca-1', iniciado_em: '2026-07-17T12:30:00.000Z', encerrado_em: '2026-07-17T14:00:00.000Z', agenda_evento_id: evento1 },
      ],
    })

    expect(result.cabines[0]).toMatchObject({ minutos_reais: 180, status_fisico: 'manutencao', sem_reserva: false })
    expect(result.cabines[0].planejamentos[0]).toMatchObject({ situacao: 'realizada', minutos_reais: 180 })
    expect(result.cabines[0].planejamentos[1]).toMatchObject({ situacao: 'manutencao' })
  })

  it('não chama ausência de falha: reserva sem ID de live vira registro pendente', () => {
    const result = buildAcompanhamento({
      data: '2026-07-17',
      dayStart: '2026-07-17T03:00:00.000Z',
      dayEnd: '2026-07-18T03:00:00.000Z',
      cabines: [{ id: cabine1, numero: 1, nome: null, status: 'disponivel' }],
      agenda: [{ id: evento1, cabine_id: cabine1, tipo: 'live', status: 'confirmado', marca_id: 'marca-1', marca_nome: 'Marca 1', data_inicio: '2026-07-17T11:00:00.000Z', data_fim: '2026-07-17T14:00:00.000Z', live_id: null }],
      lives: [],
      now: '2026-07-17T12:00:00.000Z',
    })

    expect(result.cabines[0].planejamentos[0].situacao).toBe('registro_pendente')
    expect(JSON.stringify(result)).not.toMatch(/falta|no.?show|ocios/i)
  })

  it('status de execução desconhecido não vira cancelamento; faturada conta como realizada', () => {
    const base = {
      data: '2026-07-17', dayStart: '2026-07-17T03:00:00.000Z', dayEnd: '2026-07-18T03:00:00.000Z',
      cabines: [{ id: cabine1, numero: 1, nome: null, status: 'disponivel' }],
      agenda: [{ id: evento1, cabine_id: cabine1, tipo: 'live', status: 'confirmado', marca_id: 'marca-1', marca_nome: 'Marca 1', data_inicio: '2026-07-17T11:00:00.000Z', data_fim: '2026-07-17T14:00:00.000Z', live_id: live1 }],
    }
    const unknown = buildAcompanhamento({ ...base, lives: [{ id: live1, cabine_id: cabine1, status: 'importando', marca_id: 'marca-1', iniciado_em: '2026-07-17T11:00:00.000Z', encerrado_em: null, agenda_evento_id: evento1 }] })
    expect(unknown.cabines[0].planejamentos[0]).toMatchObject({ situacao: 'registro_pendente', live_ids: [live1] })

    const billed = buildAcompanhamento({ ...base, lives: [{ id: live1, cabine_id: cabine1, status: 'faturada', marca_id: 'marca-1', iniciado_em: '2026-07-17T11:00:00.000Z', encerrado_em: '2026-07-17T13:00:00.000Z', agenda_evento_id: evento1 }] })
    expect(billed.cabines[0].planejamentos[0].situacao).toBe('realizada')
  })

  it('distingue programação da grade de reserva na agenda', () => {
    const result = buildAcompanhamento({
      data: '2026-07-17', dayStart: '2026-07-17T03:00:00.000Z', dayEnd: '2026-07-18T03:00:00.000Z',
      cabines: [{ id: cabine1, numero: 1, nome: null, status: 'disponivel' }],
      gradeCells: [{ cabine_id: cabine1, hora_inicio: '08:00', hora_fim: '11:00', marca_nome: 'Marca 1' }],
      agenda: [], lives: [],
    })
    expect(result.cabines[0]).toMatchObject({ sem_reserva: true })
    expect(result.cabines[0].programacao_grade).toHaveLength(1)
  })

  it('mantém reserva futura como planejada e descreve passado sem acusar ausência', () => {
    const base = {
      data: '2026-07-17', dayStart: '2026-07-17T03:00:00.000Z', dayEnd: '2026-07-18T03:00:00.000Z',
      now: '2026-07-17T12:00:00.000Z',
      cabines: [{ id: cabine1, numero: 1, nome: null, status: 'disponivel' }], lives: [],
    }
    const future = buildAcompanhamento({ ...base, agenda: [{ id: evento1, cabine_id: cabine1, tipo: 'live', status: 'confirmado', data_inicio: '2026-07-17T15:00:00.000Z', data_fim: '2026-07-17T18:00:00.000Z' }] })
    expect(future.cabines[0].planejamentos[0].situacao).toBe('planejada')

    const past = buildAcompanhamento({ ...base, agenda: [{ id: evento1, cabine_id: cabine1, tipo: 'live', status: 'confirmado', data_inicio: '2026-07-17T08:00:00.000Z', data_fim: '2026-07-17T11:00:00.000Z' }] })
    expect(past.cabines[0].planejamentos[0].situacao).toBe('sem_execucao_vinculada')
  })

  it('mantém registros sem cabine numa seção desconhecida', () => {
    const result = buildAcompanhamento({
      data: '2026-07-17',
      dayStart: '2026-07-17T03:00:00.000Z',
      dayEnd: '2026-07-18T03:00:00.000Z',
      cabines: [{ id: cabine1, numero: 1, nome: null, status: 'disponivel' }],
      agenda: [],
      lives: [{ id: live1, cabine_id: cabine2, status: 'encerrada', marca_id: null, marca_nome: null, iniciado_em: '2026-07-17T11:00:00.000Z', encerrado_em: '2026-07-17T12:00:00.000Z', agenda_evento_id: null }],
    })
    expect(result.cabine_desconhecida.execucoes_sem_reserva[0]).toMatchObject({ id: live1, situacao: 'sem_reserva' })
  })

  it('prioriza vínculo confirmado mesmo quando a cabine registrada diverge', () => {
    const result = buildAcompanhamento({
      data: '2026-07-17',
      dayStart: '2026-07-17T03:00:00.000Z',
      dayEnd: '2026-07-18T03:00:00.000Z',
      cabines: [
        { id: cabine1, numero: 1, nome: null, status: 'disponivel' },
        { id: cabine2, numero: 2, nome: null, status: 'disponivel' },
      ],
      agenda: [{ id: evento1, cabine_id: cabine1, tipo: 'live', status: 'confirmado', marca_id: 'marca-1', marca_nome: 'Marca 1', data_inicio: '2026-07-17T11:00:00.000Z', data_fim: '2026-07-17T14:00:00.000Z', live_id: live1 }],
      lives: [{ id: live1, cabine_id: cabine2, status: 'encerrada', marca_id: 'marca-1', marca_nome: 'Marca 1', iniciado_em: '2026-07-17T11:00:00.000Z', encerrado_em: '2026-07-17T13:00:00.000Z', agenda_evento_id: evento1 }],
    })

    expect(result.cabines[0].planejamentos[0]).toMatchObject({ situacao: 'realizada', live_ids: [live1] })
    expect(result.cabines[1].execucoes_sem_reserva).toEqual([])
    expect(result.cabines[1].minutos_reais).toBe(120)
  })

  it('cancelamento explícito da live prevalece sobre candidatos de agenda', () => {
    const result = buildAcompanhamento({
      data: '2026-07-17', dayStart: '2026-07-17T03:00:00.000Z', dayEnd: '2026-07-18T03:00:00.000Z',
      cabines: [{ id: cabine1, numero: 1, nome: null, status: 'disponivel' }],
      agenda: [{ id: evento1, cabine_id: cabine1, tipo: 'live', status: 'confirmado', marca_id: 'marca-1', data_inicio: '2026-07-17T11:00:00.000Z', data_fim: '2026-07-17T14:00:00.000Z' }],
      lives: [{ id: live1, cabine_id: cabine1, status: 'cancelada', marca_id: 'marca-1', iniciado_em: '2026-07-17T11:05:00.000Z', encerrado_em: null, agenda_evento_id: null }],
    })
    expect(result.cabines[0].execucoes_sem_reserva[0].situacao).toBe('cancelada')
  })
})

describe('GET /v1/grade/acompanhamento', () => {
  it('valida data e mantém tenant em todas as consultas', async () => {
    const app = Fastify()
    const query = vi.fn(async (sql) => {
      if (String(sql).includes('FROM cabines c')) return { rows: [{ id: cabine1, numero: 1, status: 'disponivel' }] }
      if (String(sql).includes('FROM agenda_eventos ae')) return { rows: [] }
      if (String(sql).includes('FROM lives l')) return { rows: [] }
      if (String(sql).includes('FROM grade_padrao gp')) return { rows: [] }
      if (String(sql).includes('FROM grade_excecoes ge')) return { rows: [] }
      throw new Error('SQL inesperada')
    })
    app.decorate('authenticate', async (request) => { request.user = { tenant_id: tenantId, papel: 'franqueado' } })
    app.decorate('requirePapel', () => async () => {})
    app.decorate('withTenant', async (id, fn) => {
      expect(id).toBe(tenantId)
      return fn({ query })
    })
    await app.register(gradeRoutes)

    expect((await app.inject({ method: 'GET', url: '/v1/grade/acompanhamento?data=17-07-2026' })).statusCode).toBe(400)
    const response = await app.inject({ method: 'GET', url: '/v1/grade/acompanhamento?data=2026-07-17' })
    expect(response.statusCode).toBe(200)
    expect(response.json().cabines[0]).toMatchObject({ id: cabine1, sem_reserva: true, programacao_grade: [] })
    expect(query).toHaveBeenCalledTimes(5)
    for (const [, values] of query.mock.calls) expect(values[0]).toBe(tenantId)
    await app.close()
  })
})
