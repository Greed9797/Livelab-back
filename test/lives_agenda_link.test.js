import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { livesRoutes } from '../src/routes/lives.js'
import { cabinesRoutes } from '../src/routes/cabines.js'

function buildApp({ queryMock, papel = 'franqueado' } = {}) {
  const app = Fastify()
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = {
      tenant_id: 'tenant-1',
      sub: '99999999-9999-4999-8999-999999999999',
      papel,
    }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try {
      return await fn(db)
    } finally {
      db.release()
    }
  })

  return { app, release }
}

describe('POST /v1/lives — agenda link unificada', () => {
  it('persiste agenda_evento_id e previsto_fim no INSERT lives', async () => {
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const clienteId = '22222222-2222-4222-8222-222222222222'
    const liveId = '33333333-3333-4333-8333-333333333333'
    const agendaId = '44444444-4444-4444-8444-444444444444'
    const previstoFim = '2026-05-20T22:00:00.000Z'
    let liveInsertArgs = null

    const queryMock = vi.fn(async (sql, args = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('FROM cabines') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: cabineId, numero: 1, status: 'disponivel', contrato_id: null, live_atual_id: null, ativo: true }] }
      }
      if (sql.includes('FROM agenda_eventos ae') && sql.includes('WHERE ae.id')) {
        return {
          rows: [{
            id: agendaId, status: 'planejado', marca_id: null, cabine_id: cabineId,
            apresentadora_id: null, marca_cliente_id: clienteId, marca_tipo: 'cliente', marca_tiktok_username: null,
          }],
        }
      }
      if (sql.includes('UPDATE agenda_eventos SET status')) return { rows: [] }
      if (sql.includes('FROM contratos')) {
        return { rows: [{ id: 'ct-1', cliente_id: clienteId, status: 'ativo' }] }
      }
      if (sql.includes('SELECT status FROM clientes')) return { rows: [{ status: 'ativo' }] }
      if (sql.includes('UPDATE contratos SET tiktok_username')) return { rows: [] }
      if (sql.includes('INSERT INTO lives')) {
        liveInsertArgs = args
        return { rows: [{ id: liveId, cabine_id: cabineId, iniciado_em: '2026-05-20T18:00:00.000Z', cliente_id: clienteId, apresentador_id: null, tipo: 'cliente', status_publicacao: 'rascunho', origem_dados: 'manual', agenda_evento_id: agendaId, previsto_fim: previstoFim }] }
      }
      if (sql.includes('UPDATE cabines')) return { rows: [] }
      if (sql.includes('INSERT INTO cabine_eventos')) return { rows: [] }
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lives',
      payload: { cabine_id: cabineId, agenda_evento_id: agendaId, previsto_fim: previstoFim },
    })

    expect(response.statusCode).toBe(201)
    expect(liveInsertArgs[5]).toBe(agendaId)
    expect(liveInsertArgs[6]).toBeInstanceOf(Date)
    expect(liveInsertArgs[6].toISOString()).toBe(previstoFim)
    expect(response.json()).toMatchObject({ id: liveId, agenda_evento_id: agendaId })
  })

  it('aceita apresentadora_id (novo alias) e mapeia pra apresentador_id', async () => {
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const apresentadoraId = '66666666-6666-4666-8666-666666666666'
    const apresentadoraUserId = '77777777-7777-4777-8777-777777777777'
    const liveId = '33333333-3333-4333-8333-333333333333'
    let liveInsertArgs = null

    const queryMock = vi.fn(async (sql, args = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('FROM cabines') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: cabineId, numero: 1, status: 'disponivel', contrato_id: null, live_atual_id: null, ativo: true }] }
      }
      if (sql.includes('FROM agenda_eventos')) return { rows: [] }
      if (sql.includes('SELECT user_id FROM apresentadoras')) {
        return { rows: [{ user_id: apresentadoraUserId }] }
      }
      if (sql.includes('INSERT INTO lives')) {
        liveInsertArgs = args
        return { rows: [{ id: liveId, cabine_id: cabineId, iniciado_em: '2026-05-20T18:00:00.000Z', cliente_id: null, apresentador_id: apresentadoraUserId, tipo: 'afiliado' }] }
      }
      if (sql.includes('INSERT INTO live_apresentadoras_v2')) return { rows: [] }
      if (sql.includes('UPDATE cabines')) return { rows: [] }
      if (sql.includes('INSERT INTO cabine_eventos')) return { rows: [] }
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lives',
      payload: { cabine_id: cabineId, apresentadora_id: apresentadoraId, tipo: 'afiliado' },
    })

    expect(response.statusCode).toBe(201)
    expect(liveInsertArgs[3]).toBe(apresentadoraUserId)
  })
})

describe('PATCH /v1/cabines/:id/liberar — bloqueio com live ativa', () => {
  it('retorna 409 quando existe live em_andamento na cabine', async () => {
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const liveAtivaId = '22222222-2222-4222-8222-222222222222'

    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('FROM cabines') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: cabineId, numero: 1, status: 'ao_vivo', contrato_id: null, live_atual_id: liveAtivaId }] }
      }
      if (sql.includes('FROM lives') && sql.includes("status = 'em_andamento'")) {
        return { rows: [{ id: liveAtivaId }] }
      }
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await app.register(cabinesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/cabines/${cabineId}/liberar`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'CABINE_LIVE_ATIVA', live_id: liveAtivaId })
  })

  it('permite liberar quando não há live em_andamento real (estado órfão)', async () => {
    const cabineId = '11111111-1111-4111-8111-111111111111'

    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('FROM cabines') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: cabineId, numero: 1, status: 'ao_vivo', contrato_id: null, live_atual_id: 'orfa-id' }] }
      }
      if (sql.includes('FROM lives') && sql.includes("status = 'em_andamento'")) {
        return { rows: [] }
      }
      if (sql.includes('UPDATE cabines')) {
        return { rows: [{ id: cabineId, numero: 1, status: 'disponivel', contrato_id: null }] }
      }
      if (sql.includes('INSERT INTO cabine_eventos')) return { rows: [] }
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await app.register(cabinesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/cabines/${cabineId}/liberar`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'disponivel', aviso: expect.stringContaining('órfão') })
  })
})
