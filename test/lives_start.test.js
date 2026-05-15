import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

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

describe('POST /v1/lives', () => {
  it('starts a live on an available cabine when cliente_id is provided directly', async () => {
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const clienteId = '22222222-2222-4222-8222-222222222222'
    const liveId = '33333333-3333-4333-8333-333333333333'
    const userId = '99999999-9999-4999-8999-999999999999'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: cabineId, numero: 1, status: 'disponivel', contrato_id: null, live_atual_id: null }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: liveId, cabine_id: cabineId, iniciado_em: '2026-05-15T18:00:00.000Z', cliente_id: clienteId, apresentador_id: userId }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const { app } = buildApp({ queryMock })
    await app.register(cabinesRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lives',
      payload: { cabine_id: cabineId, cliente_id: clienteId, tiktok_username: 'marca_live' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ id: liveId, cabine_id: cabineId, cliente_id: clienteId })
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO lives (tenant_id, cabine_id, cliente_id, apresentador_id)'),
      ['tenant-1', cabineId, clienteId, userId],
    )
  })
})
