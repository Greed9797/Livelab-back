import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { livesRoutes } from '../src/routes/lives.js'

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

describe('POST /v1/lives', () => {
  it('starts a live on an available cabine when cliente_id is provided directly', async () => {
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const clienteId = '22222222-2222-4222-8222-222222222222'
    const liveId = '33333333-3333-4333-8333-333333333333'
    const marcaId = '44444444-4444-4444-8444-444444444444'
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: cabineId, numero: 1, status: 'disponivel', contrato_id: null, live_atual_id: null }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'ativo' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: clienteId, nome: 'WEVANS', tiktok_username: null, site: null, logo_url: null }] })
      .mockResolvedValueOnce({ rows: [{ id: marcaId }] })
      .mockResolvedValueOnce({
          rows: [{ id: liveId, cabine_id: cabineId, iniciado_em: '2026-05-15T18:00:00.000Z', cliente_id: clienteId, apresentador_id: null, marca_id: marcaId }],
      })
    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lives',
      payload: { cabine_id: cabineId, cliente_id: clienteId },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ id: liveId, cabine_id: cabineId, cliente_id: clienteId })
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO lives (tenant_id, cabine_id, cliente_id, apresentador_id, tipo'),
      ['tenant-1', cabineId, clienteId, null, 'cliente', null, null, marcaId],
    )
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO marcas'), expect.arrayContaining([clienteId, 'WEVANS']))
  })

  it('keeps agenda apresentadora attribution without falling back to the operator user', async () => {
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const liveId = '33333333-3333-4333-8333-333333333333'
    const agendaId = '44444444-4444-4444-8444-444444444444'
    const marcaId = '55555555-5555-4555-8555-555555555555'
    const apresentadoraId = '66666666-6666-4666-8666-666666666666'
    let liveInsertArgs = null
    let v2InsertArgs = null

    const queryMock = vi.fn(async (sql, args = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM cabines')) {
        return { rows: [{ id: cabineId, numero: 1, status: 'disponivel', contrato_id: null, live_atual_id: null }] }
      }
      if (sql.includes('FROM agenda_eventos ae') && sql.includes('WHERE ae.id')) {
        return {
          rows: [{
            id: agendaId,
            status: 'planejado',
            marca_id: marcaId,
            cabine_id: cabineId,
            apresentadora_id: apresentadoraId,
            marca_cliente_id: null,
            marca_tipo: 'afiliada',
            marca_tiktok_username: 'haag_live',
          }],
        }
      }
      if (sql.includes('UPDATE agenda_eventos SET status')) return { rows: [] }
      if (sql.includes('SELECT m.cliente_id, m.tipo') && sql.includes('FROM marcas m')) {
        return { rows: [{ cliente_id: null, tipo: 'afiliada', tiktok_username: 'haag_live' }] }
      }
      if (sql.includes('SELECT user_id FROM apresentadoras')) {
        return { rows: [{ user_id: null }] }
      }
      if (sql.includes('INSERT INTO lives')) {
        liveInsertArgs = args
        return { rows: [{ id: liveId, cabine_id: cabineId, iniciado_em: '2026-05-18T18:00:00.000Z', cliente_id: null, apresentador_id: args[3] }] }
      }
      if (sql.includes('INSERT INTO live_apresentadoras_v2')) {
        v2InsertArgs = args
        return { rows: [] }
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
      payload: { cabine_id: cabineId, agenda_evento_id: agendaId, tipo: 'afiliado' },
    })

    expect(response.statusCode).toBe(201)
    expect(liveInsertArgs).toEqual(['tenant-1', cabineId, null, null, 'afiliado', agendaId, null, marcaId])
    expect(v2InsertArgs).toEqual(['tenant-1', liveId, apresentadoraId])
  })
})

describe('GET /v1/lives/:id', () => {
  it('returns a selected live by id for the current tenant', async () => {
    const liveId = '33333333-3333-4333-8333-333333333333'
    const queryMock = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: liveId,
        tenant_id: 'tenant-1',
        cabine_id: '11111111-1111-4111-8111-111111111111',
        cliente_id: '22222222-2222-4222-8222-222222222222',
        status: 'em_andamento',
        tipo: 'cliente',
        status_publicacao: 'rascunho',
        origem_dados: 'api',
        iniciado_em: '2026-05-15T18:00:00.000Z',
        cliente_nome: 'Cliente Teste',
      }],
    })
    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: `/v1/lives/${liveId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: liveId, cliente_nome: 'Cliente Teste' })
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('WHERE l.tenant_id = $1::uuid'),
      ['tenant-1', liveId],
    )
  })
})
