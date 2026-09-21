import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { clientePortalRoutes } from '../src/routes/cliente_portal.js'
import { solicitacoesRoutes } from '../src/routes/solicitacoes.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const clienteId = '22222222-2222-4222-8222-222222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'
const apresentadoraId = '44444444-4444-4444-8444-444444444444'
const userId = '55555555-5555-4555-8555-555555555555'

function buildSolicitacoesApp(queryMock) {
  const app = Fastify()
  const release = vi.fn()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: userId, papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: userId, papel: 'franqueado' }
  })
  app.decorate('db', { pool: { connect: vi.fn().mockResolvedValue({ query: queryMock, release }) } })
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })
  return { app, release }
}

describe('cabine opcional em solicitações e reserva do cliente', () => {
  it('POST /v1/solicitacoes sem cabine grava NULL e confere só a apresentadora', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.includes('set_config')) return { rows: [] }
      if (s.includes('FROM agenda_eventos')) return { rows: [] }
      if (s.includes('INSERT INTO agenda_eventos')) {
        return { rows: [{ id: 'evt-1', status: 'confirmado' }] }
      }
      return { rows: [] }
    })
    const { app } = buildSolicitacoesApp(query)
    await app.register(solicitacoesRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/solicitacoes',
      payload: {
        cliente_id: clienteId,
        marca_id: marcaId,
        apresentadora_id: apresentadoraId,
        data_solicitada: '2026-12-01',
        hora_inicio: '10:00',
        hora_fim: '12:00',
      },
    })

    expect(res.statusCode).toBe(201)
    const overlap = query.mock.calls.find(([sql]) => String(sql).includes('FROM agenda_eventos'))
    expect(String(overlap[0])).toContain('apresentadora_id = $2')
    expect(String(overlap[0])).not.toMatch(/cabine_id = \$/)
    expect(overlap[1][1]).toBe(apresentadoraId)
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO agenda_eventos'))
    expect(insert[1][1]).toBeNull()
    expect(insert[1]).not.toContain(0)
    expect(String(insert[0])).not.toMatch(/comissao/i)
    await app.close()
  })

  it('PATCH aprovar sem cabine não reserva estação e não grava comissão', async () => {
    const requestId = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const contratoId = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: requestId,
          cabine_id: null,
          apresentadora_id: apresentadoraId,
          data_inicio: '2026-12-01T13:00:00.000Z',
          data_fim: '2026-12-01T15:00:00.000Z',
          status: 'planejado',
          cliente_id: clienteId,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: contratoId }] })
      .mockResolvedValueOnce({ rows: [{ id: requestId, status: 'confirmado' }] })
      .mockResolvedValueOnce({ rows: [] })
    const { app } = buildSolicitacoesApp(query)
    await app.register(solicitacoesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/solicitacoes/${requestId}/aprovar`,
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    const overlap = query.mock.calls[3]
    expect(String(overlap[0])).toContain('apresentadora_id = $2')
    expect(String(overlap[0])).not.toMatch(/cabine_id = \$/)
    expect(overlap[1][1]).toBe(apresentadoraId)
    const sqls = query.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((sql) => sql.includes('UPDATE cabines'))).toBe(false)
    expect(sqls.some((sql) => /comissao/i.test(sql))).toBe(false)
    await app.close()
  })

  it('POST /v1/cliente/solicitacao sem cabine grava NULL e confere só a apresentadora', async () => {
    const app = Fastify()
    const sysQuery = vi.fn().mockResolvedValue({ rows: [{ cliente_id: clienteId }] })
    const tenantQuery = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('FROM cabines')) throw new Error('não deveria consultar cabine')
      if (s.includes('FROM marcas')) return { rows: [{ id: marcaId }] }
      if (s.includes('FROM agenda_eventos')) return { rows: [] }
      if (s.includes('INSERT INTO agenda_eventos')) return { rows: [{ id: 'evt-2', status: 'planejado' }] }
      return { rows: [] }
    })
    app.addHook('onRoute', (route) => {
      if (route.url === '/v1/cliente/solicitacao' && route.method === 'POST') {
        route.preHandler = [async (request) => {
          request.user = { sub: userId, tenant_id: tenantId, papel: 'cliente_parceiro' }
        }]
      }
    })
    app.decorate('authenticate', async () => {})
    app.decorate('requirePapel', () => async () => {})
    app.decorate('db', { pool: { connect: vi.fn().mockResolvedValue({ query: sysQuery, release: vi.fn() }) } })
    app.decorate('withTenant', async (_tenant, fn) => fn({ query: tenantQuery }))
    await app.register(clientePortalRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/cliente/solicitacao',
      payload: {
        apresentadora_id: apresentadoraId,
        data_solicitada: '2026-12-01',
        hora_inicio: '10:00',
        hora_fim: '12:00',
      },
    })

    expect(res.statusCode).toBe(201)
    const overlap = tenantQuery.mock.calls.find(([sql]) => String(sql).includes('FROM agenda_eventos'))
    expect(String(overlap[0])).toContain('apresentadora_id = $1')
    expect(String(overlap[0])).not.toMatch(/cabine_id = \$/)
    expect(overlap[1][0]).toBe(apresentadoraId)
    const insert = tenantQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO agenda_eventos'))
    expect(insert[1][1]).toBeNull()
    expect(insert[1][8]).toBe(apresentadoraId)
    expect(insert[1]).not.toContain(0)
    expect(String(insert[0])).not.toMatch(/comissao/i)
    await app.close()
  })
})
