import crypto from 'node:crypto'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { authPlugin } from '../src/plugins/auth.js'
import { analyticsRoutes } from '../src/routes/analytics.js'
import { cabinesRoutes } from '../src/routes/cabines.js'
import { contratosRoutes } from '../src/routes/contratos.js'
import { clienteDashboardRoutes } from '../src/routes/cliente_dashboard.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { franqueadoRoutes } from '../src/routes/franqueado.js'
import { regionalManagersRoutes } from '../src/routes/regional_managers.js'
import { leadsRoutes } from '../src/routes/leads.js'
import { solicitacoesRoutes } from '../src/routes/solicitacoes.js'

const ENV_KEYS = [
  'JWT_SECRET',
  'NODE_ENV',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'TIKTOK_REDIRECT_URI',
  'TIKTOK_WEBHOOK_REQUIRE_SIGNATURE',
  'TIKTOK_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS',
]

let envSnapshot = {}

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = envSnapshot[key]
    }
  }
})

describe('Route regressions: SQL and RBAC', () => {
  it('financeiro resumo uses CTE aggregation and keeps endpoint healthy', async () => {
    const app = Fastify()
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ fat_bruto_fixo: '1200', fat_bruto_comissao: '300', total_custos: '400' }],
    })
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    })
    // requirePapel é usado diretamente como preHandler (sem authenticate na frente)
    // → precisa setar request.user se não estiver definido
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register(financeiroRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?mes=4&ano=2026' })
    const payload = response.json()

    expect(response.statusCode).toBe(200)
    expect(payload).toMatchObject({
      fat_bruto: 1500,
      fat_liquido: 1100,
      total_custos: 400,
      periodo: '2026-04-01',
    })
    expect(queryMock).toHaveBeenCalledTimes(1)

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain('WITH contratos_periodo')
    expect(sql).toContain('custos_periodo')
    expect(sql).toContain('CROSS JOIN custos_periodo')
    expect(sql).not.toContain('COALESCE(cu.total_custos, 0)')
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('franqueado unidades query references iniciado_em (schema-safe)', async () => {
    const app = Fastify()
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-master', papel: 'franqueador_master' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('requireTenantAccess', async (request) => {
      request.isMaster = request.user.papel === 'franqueador_master'
      request.allowedTenantIds = request.isMaster ? null : []
    })
    app.decorate('db', { query: queryMock })

    await app.register(franqueadoRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/franqueado/unidades' })

    expect(response.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1)

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain('l.iniciado_em')
    expect(sql).not.toContain('l.iniciada_em')
    // Master: allowedTenantIds = null (vê tudo)
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-master', null])

    await app.close()
  })

  it('master ranking endpoint aggregates GMV, lives and retention cross-tenant', async () => {
    const app = Fastify()
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'tenant-2',
          nome: 'Franquia SP',
          gmv_mes: '12000',
          gmv_mes_anterior: '9500',
          total_lives: 18,
          total_clientes_ativos: 12,
          total_clientes_ant: 14,
        },
      ],
    })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-master', papel: 'franqueador_master' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('requireTenantAccess', async (request) => {
      request.isMaster = true
      request.allowedTenantIds = null
    })
    app.decorate('db', { query: queryMock })

    await app.register(franqueadoRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/master/ranking?periodo=2026-05',
    })
    const payload = response.json()

    expect(response.statusCode).toBe(200)
    expect(Array.isArray(payload)).toBe(true)
    expect(payload).toHaveLength(1)
    expect(payload[0]).toMatchObject({
      posicao: 1,
      tenant_id: 'tenant-2',
      tenant_nome: 'Franquia SP',
      gmv_mes: 12000,
      gmv_mes_anterior: 9500,
      total_lives: 18,
      total_clientes_ativos: 12,
    })
    expect(payload[0].crescimento_pct).toBeCloseTo(26.3, 1)
    expect(payload[0].taxa_retencao).toBeGreaterThan(0)

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain('FROM tenants t')
    expect(sql).toContain('lives_atual')
    expect(sql).toContain('lives_anterior')

    await app.close()
  })

  it('master alertas endpoint blocks non-master roles', async () => {
    const app = Fastify()
    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('requireTenantAccess', async () => {})
    app.decorate('db', { query: vi.fn() })

    await app.register(franqueadoRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/master/alertas' })
    expect(response.statusCode).toBe(403)
    await app.close()
  })

  it('master unidade historico rejects invalid tenantId and master own tenant', async () => {
    const app = Fastify()
    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-master', papel: 'franqueador_master' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('requireTenantAccess', async (request) => {
      request.isMaster = true
      request.allowedTenantIds = null
    })
    app.decorate('db', { query: vi.fn().mockResolvedValue({ rows: [] }) })

    await app.register(franqueadoRoutes)

    // Próprio tenant deve falhar
    const own = await app.inject({
      method: 'GET',
      url: '/v1/master/unidade/tenant-master/historico',
    })
    expect(own.statusCode).toBe(400)

    await app.close()
  })

  it('RBAC blocks cliente dashboard role when bypass is disabled', async () => {
    process.env.NODE_ENV = 'test'
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-please-ok'
    delete process.env.USE_DEV_BYPASS

    const app = Fastify()
    const fakeDbPlugin = fp(async (instance) => {
      instance.decorate('db', { query: vi.fn() })
    }, { name: 'db' })

    await app.register(fakeDbPlugin)
    await app.register(authPlugin)

    app.get('/rbac-check', {
      preHandler: app.requirePapel(['cliente_parceiro']),
    }, async () => ({ ok: true }))

    const token = app.jwt.sign({
      sub: 'user-1',
      tenant_id: 'tenant-1',
      papel: 'franqueado',
      nome: 'Dev User',
    })

    const response = await app.inject({
      method: 'GET',
      url: '/rbac-check',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(403)

    await app.close()
  })

  it('leads listing is scoped by franqueadora_id and tenant pickup ownership', async () => {
    const app = Fastify()
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('db', { query: queryMock, pool: { connect: vi.fn() } })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: vi.fn() }))
    app.decorate('withTenant', async (_tid, fn) => fn({ query: queryMock }))

    await app.register(leadsRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/leads' })

    expect(response.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1)

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain('franqueadora_id = $1')
    expect(sql).toContain("status != 'expirado'")
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-1'])

    await app.close()
  })

  it('leads endpoints block cliente_parceiro role', async () => {
    const app = Fastify()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', papel: 'cliente_parceiro' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('db', { query: vi.fn(), pool: { connect: vi.fn() } })

    await app.register(leadsRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/leads' })

    expect(response.statusCode).toBe(403)

    await app.close()
  })

  it('cabines list exposes contract linkage and live metrics in one query', async () => {
    const app = Fastify()
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register(cabinesRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/cabines' })

    expect(response.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledTimes(1)

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain('c.contrato_id')
    expect(sql).toContain('COALESCE(l.cliente_id, ct.cliente_id, lr_next.next_cliente_id) AS cliente_id')
    expect(sql).toContain('COALESCE(ls.viewer_count, 0) AS viewer_count')
    expect(sql).toContain('COALESCE(ls.gmv, 0) AS gmv_atual')
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('solicitacoes aprovar accepts explicit empty body', async () => {
    const app = Fastify()
    const requestId = '11111111-1111-4111-8111-111111111111'
    const cabineId = '22222222-2222-4222-8222-222222222222'
    const clienteId = '33333333-3333-4333-8333-333333333333'
    const contratoId = '44444444-4444-4444-8444-444444444444'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                    // BEGIN
      .mockResolvedValueOnce({ rows: [] })                    // set_config RLS
      .mockResolvedValueOnce({                                // lockQ FOR UPDATE
        rows: [{
          id: requestId,
          cabine_id: cabineId,
          data_solicitada: '2026-04-24',
          hora_inicio: '14:00:00',
          hora_fim: '16:00:00',
          status: 'pendente',
          cliente_id: clienteId,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })                    // overlap check
      .mockResolvedValueOnce({ rows: [{ id: contratoId }] }) // contratos check
      .mockResolvedValueOnce({                                // UPDATE live_requests
        rows: [{ id: requestId, status: 'aprovada', atualizado_em: '2026-04-24T12:00:00.000Z' }],
      })
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE cabines reservada
      .mockResolvedValueOnce({ rows: [] })                    // COMMIT
    const releaseMock = vi.fn()
    const connectMock = vi.fn().mockResolvedValue({
      query: queryMock,
      release: releaseMock,
    })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) {
        request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
      }
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('db', { pool: { connect: connectMock } })

    await app.register(solicitacoesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/solicitacoes/${requestId}/aprovar`,
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: requestId, status: 'aprovada' })
    expect(queryMock.mock.calls[2][0]).toContain('FROM live_requests')
    expect(queryMock.mock.calls[5][0]).toContain("SET status = 'aprovada'")
    expect(queryMock.mock.calls[6][0]).toContain("SET status = 'reservada', contrato_id")
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('cabine reservation only accepts active contracts from same tenant', async () => {
    const app = Fastify()
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const contratoId = '22222222-2222-4222-8222-222222222222'
    const clienteId = '33333333-3333-4333-8333-333333333333'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: cabineId, numero: 2, status: 'disponivel', contrato_id: null, live_atual_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: contratoId, cliente_id: clienteId, status: 'ativo' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: cabineId, numero: 2, status: 'reservada', contrato_id: contratoId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register(cabinesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/cabines/${cabineId}/reservar`,
      payload: { contrato_id: contratoId },
    })

    expect(response.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'reservada', contrato_id = $1"),
      [contratoId, cabineId]
    )
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('cabine_eventos'),
      expect.arrayContaining(['tenant-1', cabineId, contratoId, 'cabine_reservada', 'user-1', 'franqueado'])
    )
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('live start derives presenter and client from cabine + contrato linkage', async () => {
    const app = Fastify()
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const contratoId = '22222222-2222-4222-8222-222222222222'
    const clienteId = '33333333-3333-4333-8333-333333333333'
    const userId = '44444444-4444-4444-8444-444444444444'
    const liveId = '55555555-5555-4555-8555-555555555555'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: cabineId, numero: 1, status: 'reservada', contrato_id: contratoId, live_atual_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: contratoId, cliente_id: clienteId, status: 'ativo' }] })
      .mockResolvedValueOnce({ rows: [{ id: liveId, iniciado_em: '2026-04-03T21:00:00.000Z', cliente_id: clienteId, apresentador_id: userId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', sub: userId, papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register(cabinesRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lives',
      payload: { cabine_id: cabineId },
    })

    expect(response.statusCode).toBe(201)
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO lives (tenant_id, cabine_id, cliente_id, apresentador_id)'),
      ['tenant-1', cabineId, clienteId, userId]
    )
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('analytics resumo aggregates rankings, heatmap and realtime summary per tenant', async () => {
    const app = Fastify()
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ gmv_total_hoje: '12450.50', audiencia_total_ao_vivo: '850', total_lives_hoje: '12' }] })
      .mockResolvedValueOnce({ rows: [{ apresentador_id: 'user-1', apresentador_nome: 'Closer 1', total_lives: '45', gmv_total: '85400.00' }] })
      .mockResolvedValueOnce({ rows: [{ cliente_id: 'cli-1', cliente_nome: 'Parceiro Alpha', gmv_total: '120500.00', ultima_live: '2026-04-03T20:00:00.000Z' }] })
      .mockResolvedValueOnce({ rows: [{ hora: 20, total_lives: '25', gmv_total: '18500.00' }] })
      .mockResolvedValueOnce({ rows: [{ cabine_id: 'cab-1', cabine_nome: 'Cabine 01', total_lives: '88', gmv_acumulado: '45000.00' }] })
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register(analyticsRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/analytics/franqueado/resumo',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      resumo_hoje: {
        gmv_total_hoje: 12450.5,
        audiencia_total_ao_vivo: 850,
        total_lives_hoje: 12,
      },
      ranking_closers: [
        {
          apresentador_id: 'user-1',
          apresentador_nome: 'Closer 1',
          total_lives: 45,
          gmv_total: 85400,
        },
      ],
      ranking_clientes: [
        {
          cliente_id: 'cli-1',
          cliente_nome: 'Parceiro Alpha',
          gmv_total: 120500,
          ultima_live: '2026-04-03T20:00:00.000Z',
        },
      ],
      heatmap_horarios: [
        {
          hora: 20,
          total_lives: 25,
          gmv_total: 18500,
        },
      ],
      eficiencia_cabines: [
        {
          cabine_id: 'cab-1',
          cabine_nome: 'Cabine 01',
          total_lives: 88,
          gmv_acumulado: 45000,
        },
      ],
    })

    const realtimeSql = queryMock.mock.calls[0][0]
    expect(realtimeSql).toContain('WITH lives_ao_vivo AS')
    expect(realtimeSql).toContain('snapshots_recentes')

    const closersSql = queryMock.mock.calls[1][0]
    expect(closersSql).toContain('JOIN users u ON u.id = l.apresentador_id')

    const clientesSql = queryMock.mock.calls[2][0]
    expect(clientesSql).toContain('JOIN clientes c ON c.id = l.cliente_id')

    const heatmapSql = queryMock.mock.calls[3][0]
    expect(heatmapSql).toContain("EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::int AS hora")

    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('cliente dashboard returns monthly live performance payload with tenant-safe ranking', async () => {
    const app = Fastify()
    const clienteId = '33333333-3333-4333-8333-333333333333'
    const queryMock = vi.fn()
      // Resolução por user_id direto — não há mais SELECT email FROM users.
      .mockResolvedValueOnce({ rows: [{ id: clienteId, nicho: 'Moda Feminina', nome: 'Parceiro Alpha' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ctr-1', comissao_pct: '15.00', valor_fixo: '2400.00', horas_contratadas: '12.00', pacote_valor: null, horas_incluidas: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'live-1',
          iniciado_em: '2026-04-03T20:00:00.000Z',
          encerrado_em: '2026-04-03T22:00:00.000Z',
          cabine_numero: 3,
          apresentador_nome: 'Closer 1',
          status: 'encerrada',
          total_faturamento: '3000.00',
          comissao: '450.00',
          total_vendas: '30',
          pedidos: '24',
          viewers: '500',
          comentarios: '80',
          likes: '1200',
          shares: '20',
          duracao_min: '120',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ mes_atual: '3000.00', mes_anterior: '2000.00' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ produto: 'Vestido', qty: '12', valor: '1800.00' }] })
      .mockResolvedValueOnce({ rows: [{ cliente_id: clienteId, total: '3000.00', posicao: '1', total_participantes: '3' }] })
      .mockResolvedValueOnce({ rows: [{ nicho: 'Moda Feminina', meu_gmv: '3000.00', media_gmv_nicho: '2500.00', amostra_nicho: '9', media_gmv_geral: '4000.00', amostra_geral: '26', percentil_nicho: '0.68', percentil_geral: '0.41' }] })
      .mockResolvedValueOnce({ rows: [{ hora: 20, total_lives: '1', gmv_total: '3000.00', pedidos: '24' }] })
      .mockResolvedValueOnce({ rows: [{ ano: 2026, mes: 4, total_lives: '1', gmv_total: '3000.00', itens_vendidos: '30', horas_live: '2.00' }] })
    const releaseMock = vi.fn()

    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      request.user = { sub: 'user-1', tenant_id: 'tenant-1', papel: 'cliente_parceiro' }
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
      }
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register(clienteDashboardRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/cliente/dashboard?mes=4&ano=2026' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      periodo: { mes: 4, ano: 2026 },
      faturamento_mes: 3000,
      gmv_mes: 3000,
      crescimento_pct: 50,
      volume_vendas: 30,
      itens_vendidos: 30,
      lucro_estimado: 450,
      horas_live: 2,
      valor_investido_lives: 400,
      roas: 7.5,
      viewers: 500,
      comentarios: 80,
      likes: 1200,
      shares: 20,
      pedidos: 24,
      total_lives: 1,
      live_ativa: null,
      mais_vendidos: [
        {
          produto: 'Vestido',
          qty: 12,
          valor: 1800,
        },
      ],
      ranking_dia: {
        posicao: 1,
        gmv_periodo: 3000,
        gmv_dia: 3000,
        total_participantes: 3,
      },
      proxima_reserva: null,
      benchmark_nicho: {
        nicho: 'Moda Feminina',
        meu_gmv: 3000,
        media_gmv: 2500,
        percentual_da_media: 120,
        percentil: 0.68,
        amostra: 9,
        acima_da_media: true,
      },
      benchmark_geral: {
        nicho: null,
        meu_gmv: 3000,
        media_gmv: 4000,
        percentual_da_media: 75,
        percentil: 0.41,
        amostra: 26,
        acima_da_media: false,
      },
      melhores_horarios_venda: [
        {
          hora: 20,
          label: '20h',
          total_lives: 1,
          gmv_total: 3000,
          pedidos: 24,
        },
      ],
      series_mensais: [
        {
          mes: 4,
          ano: 2026,
          total_lives: 1,
          gmv_total: 3000,
          itens_vendidos: 30,
          horas_live: 2,
          valor_investido_lives: 400,
          roas: 7.5,
        },
      ],
      lives: [
        {
          id: 'live-1',
          total_faturamento: 3000,
          gmv: 3000,
          comissao: 450,
          total_vendas: 30,
          itens_vendidos: 30,
          duracao_min: 120,
          duracao_horas: 2,
          valor_investido: 400,
          roas: 7.5,
        },
      ],
    })

    const livesSql = queryMock.mock.calls[2][0]
    expect(livesSql).toContain('final_peak_viewers')
    expect(livesSql).toContain("make_timestamptz($3::int, $4::int")

    const rankingSql = queryMock.mock.calls[6][0]
    expect(rankingSql).toContain('l.tenant_id = $1')
    expect(rankingSql).toContain('l.iniciado_em >= p.inicio')

    const benchmarkSql = queryMock.mock.calls[7][0]
    expect(benchmarkSql).toContain('WITH base_90_dias AS')
    expect(benchmarkSql).toContain('PERCENT_RANK() OVER')
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('cliente dashboard returns empty payload when no active cliente is linked', async () => {
    const app = Fastify()
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // SELECT clientes WHERE user_id = $1 → vazio
    const releaseMock = vi.fn()

    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      request.user = { sub: 'user-1', tenant_id: 'tenant-1', papel: 'cliente_parceiro' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register(clienteDashboardRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/cliente/dashboard?mes=4&ano=2026' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      periodo: { mes: 4, ano: 2026 },
      faturamento_mes: 0,
      volume_vendas: 0,
      valor_investido_lives: 0,
      melhores_horarios_venda: [],
      lives: [],
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('cliente lives and vendas endpoints return enriched monthly history', async () => {
    for (const url of ['/v1/cliente/lives?mes=4&ano=2026', '/v1/cliente/vendas?mes=4&ano=2026']) {
      const app = Fastify()
      const clienteId = '33333333-3333-4333-8333-333333333333'
      const queryMock = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: clienteId, nicho: 'Moda Feminina', nome: 'Parceiro Alpha' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'ctr-1', comissao_pct: '10.00', valor_fixo: '1000.00', horas_contratadas: '10.00', pacote_valor: null, horas_incluidas: null }] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'live-1',
            iniciado_em: '2026-04-03T20:00:00.000Z',
            encerrado_em: '2026-04-03T21:30:00.000Z',
            cabine_numero: 3,
            apresentador_nome: 'Closer 1',
            status: 'encerrada',
            total_faturamento: '1800.00',
            comissao: '180.00',
            total_vendas: '18',
            pedidos: '14',
            viewers: '250',
            comentarios: '40',
            likes: '800',
            shares: '12',
            duracao_min: '90',
          }],
        })
      const releaseMock = vi.fn()

      app.decorate('requirePapel', (papeis) => async (request, reply) => {
        request.user = { sub: 'user-1', tenant_id: 'tenant-1', papel: 'cliente_parceiro' }
        if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
      })
      app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

      await app.register(clienteDashboardRoutes)

      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        periodo: { mes: 4, ano: 2026 },
        resumo: {
          gmv_total: 1800,
          total_vendas: 18,
          itens_vendidos: 18,
          total_lives: 1,
          horas_live: 1.5,
          valor_investido_lives: 150,
          roas: 12,
          viewers: 250,
          comentarios: 40,
          likes: 800,
          shares: 12,
          pedidos: 14,
        },
        lives: [
          {
            id: 'live-1',
            gmv: 1800,
            duracao_min: 90,
            duracao_horas: 1.5,
            valor_investido: 150,
            roas: 12,
          },
        ],
      })
      expect(queryMock.mock.calls[2][0]).toContain("make_timestamptz($3::int, $4::int")
      expect(releaseMock).toHaveBeenCalledTimes(1)

      await app.close()
    }
  })

  it('cliente cabines endpoints are blocked with 403 for cliente_parceiro', async () => {
    const app = Fastify()
    const dbTenantMock = vi.fn()

    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      request.user = { sub: 'user-1', tenant_id: 'tenant-1', papel: 'cliente_parceiro' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', dbTenantMock)
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register(clienteDashboardRoutes)

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/cliente/cabines' }),
      app.inject({ method: 'GET', url: '/v1/cliente/cabines/33333333-3333-4333-8333-333333333333' }),
      app.inject({ method: 'GET', url: '/v1/cliente/cabines/33333333-3333-4333-8333-333333333333/solicitacoes' }),
      app.inject({
        method: 'POST',
        url: '/v1/cliente/cabines/33333333-3333-4333-8333-333333333333/solicitar-live',
        payload: { data_solicitada: '2026-04-30', hora_inicio: '20:00', hora_fim: '22:00' },
      }),
    ])

    for (const response of responses) {
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: 'Cliente parceiro não tem acesso a cabines' })
    }
    expect(dbTenantMock).not.toHaveBeenCalled()

    await app.close()
  })

  it('POST /v1/financeiro/custos deve usar dbTenant (não app.db)', async () => {
    const app = Fastify()
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ id: 'uuid-1', descricao: 'Aluguel', valor: 1500, tipo: 'aluguel', competencia: '2026-04' }]
    })
    const mockRelease = vi.fn()

    app.decorate('authenticate', async (req) => {
      req.user = { sub: 'user-1', tenant_id: 'tenant-1', papel: 'franqueado' }
    })
    // requirePapel é o único preHandler na rota → seta request.user se não definido
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) request.user = { sub: 'user-1', tenant_id: 'tenant-1', papel: 'franqueado' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })
    app.decorate('db', { query: vi.fn() })

    await app.register(financeiroRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/financeiro/custos',
      payload: { descricao: 'Aluguel', valor: 1500, tipo: 'aluguel', competencia: '2026-04' }
    })

    expect(res.statusCode).toBe(201)
    expect(app.dbTenant).toHaveBeenCalledWith('tenant-1')
    expect(mockRelease).toHaveBeenCalled()
    expect(app.db.query).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO custos'),
      ['tenant-1', 'Aluguel', 1500, 'aluguel', '2026-04']
    )

    await app.close()
  })

  it('GET /v1/lives/:liveId/stream retorna 404 quando live não pertence ao tenant', async () => {
    const app = Fastify()
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1' }
    })
    app.decorate('db', { query: queryMock })

    app.get('/v1/lives/:liveId/stream',
      { preHandler: [app.authenticate] },
      async (request, reply) => {
        const { tenant_id } = request.user
        const { liveId } = request.params
        const { rows } = await app.db.query(
          `SELECT id FROM lives WHERE id = $1 AND tenant_id = $2 AND status = 'em_andamento'`,
          [liveId, tenant_id, 'em_andamento']
        )
        if (rows.length === 0) return reply.code(404).send({ error: 'Live não encontrada ou não está ao vivo' })
        return reply.send({ ok: true })
      }
    )

    const response = await app.inject({
      method: 'GET',
      url: '/v1/lives/live-nao-existe/stream',
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: expect.any(String) })
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1 AND tenant_id = $2'),
      expect.arrayContaining(['live-nao-existe', 'tenant-1'])
    )

    await app.close()
  })

  it('live-atual retorna live_id no payload', async () => {
    const app = Fastify()
    const liveId = 'live-uuid-123'
    const cabineId = 'cabine-uuid-456'

    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ live_atual_id: liveId, status: 'ao_vivo' }] })  // cabine query
      .mockResolvedValueOnce({ rows: [{ id: liveId }] })  // lives em_andamento search
      .mockResolvedValueOnce({ rows: [{ iniciado_em: new Date().toISOString(), fat_gerado: 0, contrato_id: null, apresentador_nome: 'Closer', cliente_nome: 'Parceiro', tiktok_username: null }] })  // live full data
      .mockResolvedValueOnce({ rows: [{ viewer_count: 10, total_viewers: 0, total_orders: 2, gmv: 500, likes_count: 50, comments_count: 30, gifts_diamonds: 0, shares_count: 0 }] })  // snapshot
      .mockResolvedValueOnce({ rows: [] })  // top produto
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) {
        return reply.code(403).send({ error: 'Acesso não autorizado' })
      }
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })

    await app.register((await import('../src/routes/cabines.js')).cabinesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: `/v1/cabines/${cabineId}/live-atual`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ live_id: liveId })

    await app.close()
  })

  // ── TikTok OAuth CSRF regression ─────────────────────────────────────────
  describe('TikTok OAuth CSRF (signed state)', () => {
    function signTikTokWebhookPayload(payload, timestamp = Math.floor(Date.now() / 1000)) {
      const body = JSON.stringify(payload)
      const signature = crypto
        .createHmac('sha256', process.env.TIKTOK_CLIENT_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex')

      return {
        body,
        signature: `t=${timestamp},s=${signature}`,
      }
    }

    async function buildTiktokApp() {
      process.env.JWT_SECRET = 'test-secret-32-chars-minimum-please-ok'
      process.env.TIKTOK_OAUTH_ENABLED = 'true'
      process.env.TIKTOK_CLIENT_KEY = 'test-client-key'
      process.env.TIKTOK_CLIENT_SECRET = 'test-client-secret'
      process.env.TIKTOK_REDIRECT_URI = 'https://api.test.com/v1/tiktok/callback'
      const app = Fastify()
      const queryMock = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'tenant-1' }] })
      const releaseMock = vi.fn()
      app.decorate('authenticate', async (request) => {
        request.user = { tenant_id: '00000000-0000-0000-0000-000000000001', papel: 'franqueado' }
      })
      app.decorate('requirePapel', (papeis) => async (request, reply) => {
        if (!request.user) request.user = { tenant_id: '00000000-0000-0000-0000-000000000001', papel: 'franqueado' }
        if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
      })
      app.decorate('db', { query: queryMock })
      app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })
      const { tiktokRoutes } = await import('../src/routes/tiktok.js')
      await app.register(tiktokRoutes)
      return { app, queryMock }
    }

    it('GET /v1/tiktok/callback rejeita state sem assinatura (formato UUID)', async () => {
      const { app } = await buildTiktokApp()
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tiktok/callback?code=fake&state=00000000-0000-0000-0000-000000000001',
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/State inválido/)
      await app.close()
    })

    it('GET /v1/tiktok/callback rejeita state com assinatura tampered', async () => {
      const { app } = await buildTiktokApp()
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tiktok/callback?code=fake&state=tenant-1:nonce:9999999999999:BADSIG1234567890',
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/State inválido/)
      await app.close()
    })

    it('GET /tiktokqs5mPOzi5Iq2tckHy7mVhYMDBFtf0oDd.txt expõe o arquivo de verificação do TikTok', async () => {
      const { app } = await buildTiktokApp()
      const res = await app.inject({
        method: 'GET',
        url: '/tiktokqs5mPOzi5Iq2tckHy7mVhYMDBFtf0oDd.txt',
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/text\/plain/)
      expect(res.body).toBe('tiktok-developers-site-verification=qs5mPOzi5Iq2tckHy7mVhYMDBFtf0oDd')
      await app.close()
    })

    it('GET /v1/lives/:liveId/events retorna 404 se live não existe ou não está em_andamento', async () => {
      process.env.JWT_SECRET = 'test-secret-32-chars-minimum-please-ok'
      process.env.TIKTOK_CLIENT_KEY = 'test-client-key'
      process.env.TIKTOK_CLIENT_SECRET = 'test-client-secret'
      process.env.TIKTOK_REDIRECT_URI = 'https://api.test.com/v1/tiktok/callback'
      const app = Fastify()
      const queryMock = vi.fn().mockResolvedValue({ rows: [] }) // live inexistente
      app.decorate('authenticate', async (request) => {
        request.user = { tenant_id: '00000000-0000-0000-0000-000000000001', papel: 'franqueado' }
      })
      app.decorate('requirePapel', (papeis) => async (request, reply) => {
        if (!request.user) request.user = { tenant_id: '00000000-0000-0000-0000-000000000001', papel: 'franqueado' }
        if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
      })
      app.decorate('db', { query: queryMock })
      app.decorate('dbTenant', async () => ({ query: queryMock, release: vi.fn() }))
      app.decorate('withTenant', async (tenantId, fn) => {
        const db = await app.dbTenant(tenantId)
        try { return await fn(db) } finally { db.release() }
      })
      const { tiktokRoutes } = await import('../src/routes/tiktok.js')
      await app.register(tiktokRoutes)

      const res = await app.inject({
        method: 'GET',
        url: '/v1/lives/00000000-0000-0000-0000-000000000999/events',
      })
      expect(res.statusCode).toBe(404)
      expect(res.json().error).toMatch(/não encontrada|não está ao vivo/i)
      await app.close()
    })

    it('POST /v1/tiktok/webhook registra evento assinado e revoga tokens no authorization.removed', async () => {
      const { app, queryMock } = await buildTiktokApp()
      const payload = {
        client_key: 'test-client-key',
        event: 'authorization.removed',
        create_time: 1_615_338_610,
        user_openid: 'open-id-1',
        content: '{"reason":1}',
      }
      const { body, signature } = signTikTokWebhookPayload(payload)

      queryMock.mockReset()
      queryMock
        .mockResolvedValueOnce({ rows: [{ id: 'tenant-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'POST',
        url: '/v1/tiktok/webhook',
        headers: {
          'content-type': 'application/json',
          'tiktok-signature': signature,
        },
        payload: body,
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ received: true })
      expect(queryMock).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('SELECT id FROM tenants WHERE tiktok_user_id = $1'),
        ['open-id-1']
      )
      expect(queryMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO webhook_eventos'),
        ['tenant-1', 'authorization.removed', body]
      )
      expect(queryMock.mock.calls[2][0]).toContain('SET tiktok_access_token = NULL')

      await app.close()
    })

    it('POST /v1/tiktok/webhook rejeita assinatura inválida quando validação obrigatória está ativa', async () => {
      process.env.TIKTOK_WEBHOOK_REQUIRE_SIGNATURE = 'true'
      const { app, queryMock } = await buildTiktokApp()
      const body = JSON.stringify({
        client_key: 'test-client-key',
        event: 'authorization.removed',
        create_time: 1_615_338_610,
        user_openid: 'open-id-1',
        content: '{"reason":1}',
      })
      queryMock.mockClear()

      const res = await app.inject({
        method: 'POST',
        url: '/v1/tiktok/webhook',
        headers: {
          'content-type': 'application/json',
          'tiktok-signature': `t=${Math.floor(Date.now() / 1000)},s=deadbeef`,
        },
        payload: body,
      })

      expect(res.statusCode).toBe(401)
      expect(res.json().error).toMatch(/Assinatura TikTok inválida/)
      expect(queryMock).not.toHaveBeenCalled()

      await app.close()
    })

    it('RBAC: gerente tem acesso às rotas operacionais; apresentador só acessa cabines', async () => {
      const { cabinesRoutes } = await import('../src/routes/cabines.js')
      const { financeiroRoutes } = await import('../src/routes/financeiro.js')

      // gerente deve acessar financeiro (mesmo acesso que franqueado)
      const appGerente = Fastify()
      const queryMock = vi.fn().mockResolvedValue({ rows: [{ fat_bruto_fixo: '0', fat_bruto_comissao: '0', total_custos: '0' }] })
      const releaseMock = vi.fn()
      appGerente.decorate('authenticate', async (req) => {
        req.user = { tenant_id: 'tenant-1', papel: 'gerente' }
      })
      appGerente.decorate('requirePapel', (papeis) => async (request, reply) => {
        if (!request.user) request.user = { tenant_id: 'tenant-1', papel: 'gerente' }
        if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
      })
      appGerente.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
      appGerente.decorate('withTenant', async (tenantId, fn) => {
        const db = await appGerente.dbTenant(tenantId)
        try { return await fn(db) } finally { db.release() }
      })
      await appGerente.register(financeiroRoutes)
      const resGerente = await appGerente.inject({ method: 'GET', url: '/v1/financeiro/resumo?mes=4&ano=2026' })
      expect(resGerente.statusCode).toBe(200)
      await appGerente.close()

      // apresentador deve acessar cabines
      const appApresentador = Fastify()
      const cabQueryMock = vi.fn().mockResolvedValue({ rows: [] })
      const cabReleaseMock = vi.fn()
      appApresentador.decorate('authenticate', async (req) => {
        req.user = { tenant_id: 'tenant-1', papel: 'apresentador' }
      })
      appApresentador.decorate('requirePapel', (papeis) => async (request, reply) => {
        if (!request.user) request.user = { tenant_id: 'tenant-1', papel: 'apresentador' }
        if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
      })
      appApresentador.decorate('dbTenant', async () => ({ query: cabQueryMock, release: cabReleaseMock }))
      appApresentador.decorate('withTenant', async (tenantId, fn) => {
        const db = await appApresentador.dbTenant(tenantId)
        try { return await fn(db) } finally { db.release() }
      })
      await appApresentador.register(cabinesRoutes)
      const resApresentador = await appApresentador.inject({ method: 'GET', url: '/v1/cabines' })
      expect(resApresentador.statusCode).toBe(200)
      await appApresentador.close()

      // apresentador NÃO deve acessar financeiro
      const appApresentadorFin = Fastify()
      appApresentadorFin.decorate('authenticate', async (req) => {
        req.user = { tenant_id: 'tenant-1', papel: 'apresentador' }
      })
      appApresentadorFin.decorate('requirePapel', (papeis) => async (request, reply) => {
        if (!request.user) request.user = { tenant_id: 'tenant-1', papel: 'apresentador' }
        if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
      })
      appApresentadorFin.decorate('dbTenant', async () => ({ query: vi.fn(), release: vi.fn() }))
      await appApresentadorFin.register(financeiroRoutes)
      const resApresentadorFin = await appApresentadorFin.inject({ method: 'GET', url: '/v1/financeiro/resumo?mes=4&ano=2026' })
      expect(resApresentadorFin.statusCode).toBe(403)
      await appApresentadorFin.close()
    })

    it('GET /v1/tiktok/callback aceita signed state válido gerado por createSignedState', async () => {
      const { app, queryMock } = await buildTiktokApp()
      const { createSignedState } = await import('../src/services/oauth-state.js')
      const validState = createSignedState({
        tenantId: '00000000-0000-0000-0000-000000000001',
        nonce: 'test-nonce',
      })
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tiktok/callback?code=fake&state=${encodeURIComponent(validState)}`,
      })
      // Callback roda com sucesso (retorna HTML de "conectado") ou 404 se tenant não existe.
      // Nosso mock retorna rowCount=1 (tenant existe), então deve ter status 200 com HTML.
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/text\/html/)
      // Deve ter chamado db.query pra verificar tenant + atualizar tokens
      expect(queryMock).toHaveBeenCalled()
      await app.close()
    })
  })

  it('solicitacoes aprovar retorna 422 quando cliente nao tem contrato ativo', async () => {
    const app = Fastify()
    const requestId = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const cabineId = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const clienteId = 'cccc3333-cccc-4ccc-8ccc-cccccccccccc'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })           // BEGIN
      .mockResolvedValueOnce({ rows: [] })           // set_config RLS
      .mockResolvedValueOnce({                       // lockQ FOR UPDATE
        rows: [{
          id: requestId, cabine_id: cabineId,
          data_solicitada: '2026-05-11',
          hora_inicio: '14:00:00', hora_fim: '16:00:00',
          status: 'pendente', cliente_id: clienteId,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })           // overlap check
      .mockResolvedValueOnce({ rows: [] })           // contratos check → nenhum ativo
      .mockResolvedValueOnce({ rows: [] })           // ROLLBACK
    const releaseMock = vi.fn()
    const connectMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('db', { pool: { connect: connectMock } })
    await app.register(solicitacoesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/solicitacoes/${requestId}/aprovar`,
      payload: {},
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'NO_ACTIVE_CONTRACT', cliente_id: clienteId })
    expect(queryMock.mock.calls[4][0]).toContain('FROM contratos')
    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('solicitacoes aprovar com contrato ativo reserva cabine na mesma transacao', async () => {
    const app = Fastify()
    const requestId = 'dddd4444-dddd-4ddd-8ddd-dddddddddddd'
    const cabineId = 'eeee5555-eeee-4eee-8eee-eeeeeeeeeeee'
    const clienteId = 'ffff6666-ffff-4fff-8fff-ffffffffffff'
    const contratoId = '00007777-0000-4000-8000-000000000000'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                    // BEGIN
      .mockResolvedValueOnce({ rows: [] })                    // set_config RLS
      .mockResolvedValueOnce({                                // lockQ FOR UPDATE
        rows: [{
          id: requestId, cabine_id: cabineId,
          data_solicitada: '2026-05-11',
          hora_inicio: '10:00:00', hora_fim: '12:00:00',
          status: 'pendente', cliente_id: clienteId,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })                    // overlap check
      .mockResolvedValueOnce({ rows: [{ id: contratoId }] }) // contratos check → ativo
      .mockResolvedValueOnce({                                // UPDATE live_requests
        rows: [{ id: requestId, status: 'aprovada', atualizado_em: '2026-05-11T12:00:00.000Z' }],
      })
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE cabines reservada
      .mockResolvedValueOnce({ rows: [] })                    // COMMIT
    const releaseMock = vi.fn()
    const connectMock = vi.fn().mockResolvedValue({ query: queryMock, release: releaseMock })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('db', { pool: { connect: connectMock } })
    await app.register(solicitacoesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/solicitacoes/${requestId}/aprovar`,
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: requestId, status: 'aprovada' })
    expect(queryMock.mock.calls[6][0]).toContain("SET status = 'reservada', contrato_id")
    expect(queryMock.mock.calls[6][1]).toEqual([contratoId, cabineId, 'tenant-1'])
    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('POST /v1/lives auto-reserves cabine disponivel with approved LR and active contrato', async () => {
    const app = Fastify()
    const cabineId = 'a1111111-a111-4a11-8a11-a11111111111'
    const clienteId = 'b2222222-b222-4b22-8b22-b22222222222'
    const contratoId = 'c3333333-c333-4c33-8c33-c33333333333'
    const userId = 'd4444444-d444-4d44-8d44-d44444444444'
    const liveId = 'e5555555-e555-4e55-8e55-e55555555555'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })           // BEGIN
      .mockResolvedValueOnce({                       // SELECT cabine FOR UPDATE → disponivel
        rows: [{ id: cabineId, numero: 1, status: 'disponivel', contrato_id: null, live_atual_id: null }],
      })
      .mockResolvedValueOnce({                       // SELECT live_requests (auto-reserve)
        rows: [{ cliente_id: clienteId }],
      })
      .mockResolvedValueOnce({                       // SELECT contratos (ctLrQ)
        rows: [{ id: contratoId }],
      })
      .mockResolvedValueOnce({ rows: [] })           // UPDATE cabines reservada
      .mockResolvedValueOnce({                       // SELECT contratos FOR UPDATE
        rows: [{ id: contratoId, cliente_id: clienteId, status: 'ativo' }],
      })
      .mockResolvedValueOnce({                       // INSERT INTO lives
        rows: [{ id: liveId, iniciado_em: new Date().toISOString(), cliente_id: clienteId, apresentador_id: userId }],
      })
      .mockResolvedValueOnce({ rows: [] })           // UPDATE cabines ao_vivo
      .mockResolvedValueOnce({ rows: [] })           // INSERT cabine_eventos
      .mockResolvedValueOnce({ rows: [] })           // COMMIT
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', sub: userId, papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })
    await app.register(cabinesRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lives',
      payload: { cabine_id: cabineId },
    })

    expect(response.statusCode).toBe(201)
    expect(queryMock.mock.calls[2][0]).toContain('FROM live_requests')
    expect(queryMock.mock.calls[2][1]).toEqual([cabineId, 'tenant-1'])
    expect(queryMock.mock.calls[4][0]).toContain("SET status = 'reservada', contrato_id")
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO lives'),
      expect.arrayContaining([cabineId, clienteId])
    )
    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // ─── Contratos — GET ?cliente_id e PATCH /ativar ─────────────────────
  it('GET /v1/contratos?cliente_id filtra contratos por cliente', async () => {
    const app = Fastify()
    const clienteId = 'aaaaaa01-0000-4000-8000-000000000001'
    const contratoId = 'bbbbbb01-0000-4000-8000-000000000001'
    const queryMock = vi.fn().mockResolvedValueOnce({
      rows: [{ id: contratoId, status: 'rascunho', valor_fixo: '0', comissao_pct: '0', criado_em: new Date() }],
    })
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })
    app.decorate('audit', { log: vi.fn().mockReturnValue(Promise.resolve()) })
    await app.register(contratosRoutes)

    const res = await app.inject({ method: 'GET', url: `/v1/contratos?cliente_id=${clienteId}` })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain('c.cliente_id = $1')
    expect(queryMock.mock.calls[0][1]).toEqual([clienteId])
    await app.close()
  })

  it('PATCH /v1/contratos/:id/ativar ativa contrato rascunho e retorna status ativo', async () => {
    const app = Fastify()
    const contratoId = 'cccccc01-0000-4000-8000-000000000001'
    const userId = 'dddddd01-0000-4000-8000-000000000001'
    const now = new Date().toISOString()
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: contratoId, status: 'rascunho' }] })  // SELECT check
      .mockResolvedValueOnce({ rows: [{ id: contratoId, status: 'ativo', ativado_em: now }] }) // UPDATE
    const releaseMock = vi.fn()

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: 'tenant-1', sub: userId, papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) request.user = { tenant_id: 'tenant-1', sub: userId, papel: 'franqueado' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })
    app.decorate('audit', { log: vi.fn().mockReturnValue(Promise.resolve()) })
    await app.register(contratosRoutes)

    const res = await app.inject({ method: 'PATCH', url: `/v1/contratos/${contratoId}/ativar` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: contratoId, status: 'ativo' })
    const updateSql = queryMock.mock.calls[1][0]
    expect(updateSql).toContain("SET status = 'ativo'")
    expect(queryMock.mock.calls[1][1]).toEqual([userId, contratoId])
    await app.close()
  })

  // ─── Fase C: gerente_regional (Tier 4, multi-tenant) ─────────────────
  describe('gerente_regional (Tier 4, multi-tenant)', () => {
    function setupRegionalApp({ papel, allowedTenantIds, queryMock }) {
      const app = Fastify()
      app.decorate('authenticate', async (request) => {
        request.user = {
          tenant_id: 'tenant-master',
          papel,
          sub: 'user-regional-1',
        }
      })
      app.decorate('requirePapel', (papeis) => async (request, reply) => {
        if (!papeis.includes(request.user.papel)) {
          return reply.code(403).send({ error: 'Forbidden' })
        }
      })
      app.decorate('requireTenantAccess', async (request) => {
        if (request.user.papel === 'franqueador_master') {
          request.isMaster = true
          request.allowedTenantIds = null
        } else if (request.user.papel === 'gerente_regional') {
          request.isMaster = false
          request.allowedTenantIds = allowedTenantIds
        }
      })
      app.decorate('db', { query: queryMock, pool: { connect: vi.fn() } })
      return app
    }

    it('gerente_regional injeta allowedTenantIds nas queries do dashboard', async () => {
      const queryMock = vi.fn().mockResolvedValue({ rows: [] })
      const app = setupRegionalApp({
        papel: 'gerente_regional',
        allowedTenantIds: ['tenant-a', 'tenant-b'],
        queryMock,
      })
      await app.register(franqueadoRoutes)

      const res = await app.inject({
        method: 'GET',
        url: '/v1/master/dashboard?periodo=2026-05',
      })
      expect(res.statusCode).toBe(200)
      // Pelo menos uma query deve ter sido chamada com array de tenants permitidos
      const callsWithAllowed = queryMock.mock.calls.filter((call) =>
        call[1]?.some(
          (param) =>
            Array.isArray(param) &&
            param.includes('tenant-a') &&
            param.includes('tenant-b')
        )
      )
      expect(callsWithAllowed.length).toBeGreaterThan(0)
      await app.close()
    })

    it('franqueador_master continua passando NULL como allowedTenantIds (vê tudo)', async () => {
      const queryMock = vi.fn().mockResolvedValue({ rows: [] })
      const app = setupRegionalApp({
        papel: 'franqueador_master',
        allowedTenantIds: null,
        queryMock,
      })
      await app.register(franqueadoRoutes)

      const res = await app.inject({
        method: 'GET',
        url: '/v1/master/dashboard?periodo=2026-05',
      })
      expect(res.statusCode).toBe(200)
      // Em pelo menos uma query, o último param deve ser null (=master vê tudo)
      const masterCalls = queryMock.mock.calls.filter((call) =>
        call[1]?.includes(null)
      )
      expect(masterCalls.length).toBeGreaterThan(0)
      await app.close()
    })

    it('gerente_regional /v1/master/unidade/:tenantId/historico bloqueia tenant fora da lista', async () => {
      const queryMock = vi.fn().mockResolvedValue({ rows: [] })
      const app = setupRegionalApp({
        papel: 'gerente_regional',
        allowedTenantIds: ['tenant-a'],
        queryMock,
      })
      await app.register(franqueadoRoutes)

      const blocked = await app.inject({
        method: 'GET',
        url: '/v1/master/unidade/tenant-fora-da-lista/historico',
      })
      expect(blocked.statusCode).toBe(403)

      const allowed = await app.inject({
        method: 'GET',
        url: '/v1/master/unidade/tenant-a/historico',
      })
      expect(allowed.statusCode).toBe(200)
      await app.close()
    })

    it('regional-managers list endpoint só aceita franqueador_master', async () => {
      const app = Fastify()
      app.decorate('authenticate', async (request) => {
        request.user = { tenant_id: 'x', papel: 'gerente_regional' }
      })
      app.decorate('requirePapel', (papeis) => async (request, reply) => {
        if (!papeis.includes(request.user.papel)) {
          return reply.code(403).send({ error: 'Forbidden' })
        }
      })
      app.decorate('db', {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        pool: { connect: vi.fn() },
      })
      await app.register(regionalManagersRoutes)

      const res = await app.inject({
        method: 'GET',
        url: '/v1/master/regional-managers',
      })
      expect(res.statusCode).toBe(403)
      await app.close()
    })
  })
})
