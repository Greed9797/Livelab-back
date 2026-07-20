/**
 * Comissões do modal operacional (bug Posthaus):
 * GET /v1/marcas/:id/operacional e getClienteOperacional devem somar comissões
 * APENAS do período pedido e SEM vendas reprovadas — antes somavam a vida inteira.
 */

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { getClienteOperacional, resolveMonthRange } from '../src/lib/operacional.js'
import { marcasRoutes } from '../src/routes/marcas.js'

const REPROVADA_FILTER = "COALESCE(v.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'"
const PERIODO_FILTER = 'FILTER (WHERE v.data >= $3::date'

function buildApp(queryMock) {
  const app = Fastify()
  const releaseMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('db', { query: queryMock })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return app
}

describe('resolveMonthRange', () => {
  it('aceita periodo=YYYY-MM', () => {
    expect(resolveMonthRange({ periodo: '2026-06' })).toEqual({ startDate: '2026-06-01', endDate: '2026-06-30' })
  })

  it('aceita mes/ano numéricos (compat com o resto das telas)', () => {
    expect(resolveMonthRange({ mes: 6, ano: 2026 })).toEqual({ startDate: '2026-06-01', endDate: '2026-06-30' })
    expect(resolveMonthRange({ mes: '2', ano: '2026' })).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' })
  })

  it('sem params → mês corrente (primeiro ao último dia)', () => {
    const { startDate, endDate } = resolveMonthRange({})
    expect(startDate).toMatch(/^\d{4}-\d{2}-01$/)
    expect(endDate.slice(0, 7)).toBe(startDate.slice(0, 7))
  })
})

describe('GET /v1/marcas/:id/operacional — comissões por período, sem reprovadas', () => {
  it('metrics filtra as 3 somas de comissão por data e exclui reprovadas', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('WITH vendas AS')) {
        return { rows: [{ gmv_mes: '1000', comissao_franquia: '100', comissao_franqueadora: '20', comissao_apresentadora: '10' }] }
      }
      if (sql.includes('FROM marcas m')) return { rows: [{ id: 'marca-1', nome: 'Posthaus', tipo: 'cliente' }] }
      return { rows: [] }
    })
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/marcas/marca-1/operacional?periodo=2026-06' })

    expect(res.statusCode).toBe(200)
    expect(res.json().periodo).toEqual({ inicio: '2026-06-01', fim: '2026-06-30' })
    expect(res.json().metrics.comissao_franquia).toBe(100)

    const metricsCall = queryMock.mock.calls.find(([sql]) => sql.includes('WITH vendas AS'))
    expect(metricsCall).toBeTruthy()
    const [sql, params] = metricsCall
    expect(params).toEqual(['marca-1', 'tenant-uuid-1', '2026-06-01', '2026-06-30'])
    // As 3 somas (franquia, franqueadora, apresentadora) têm o mesmo FILTER.
    expect(sql).toContain(`SUM(v.comissao_franquia) ${PERIODO_FILTER}`)
    expect(sql).toContain(`SUM(v.comissao_franqueadora) ${PERIODO_FILTER}`)
    expect(sql).toContain(`SUM(v.comissao_apresentadora) ${PERIODO_FILTER}`)
    expect(sql.match(/<> 'reprovada'/g)).toHaveLength(3)
    await app.close()
  })
})

describe('getClienteOperacional — comissões por período, sem reprovadas', () => {
  it('metrics do cliente aplica o mesmo filtro nas 3 somas', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('FROM clientes')) return { rows: [{ id: 'cli-1', nome: 'Posthaus' }] }
      if (sql.includes('WITH marca_scope AS')) {
        return { rows: [{ gmv_mes: '1000', comissao_franquia: '100' }] }
      }
      return { rows: [] }
    })

    const detail = await getClienteOperacional({ query: queryMock }, {
      tenantId: 'tenant-uuid-1',
      clienteId: 'cli-1',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    })

    expect(detail.metrics.comissao_franquia).toBe(100)
    const metricsCall = queryMock.mock.calls.find(([sql]) => sql.includes('WITH marca_scope AS'))
    const [sql, params] = metricsCall
    expect(params).toEqual(['cli-1', 'tenant-uuid-1', '2026-06-01', '2026-06-30'])
    expect(sql).toContain(`SUM(v.comissao_franquia) ${PERIODO_FILTER}`)
    expect(sql).toContain(REPROVADA_FILTER)
    expect(sql.match(/<> 'reprovada'/g)).toHaveLength(3)
  })
})
