import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'

vi.mock('../src/services/financeiro-agregador.js', async (original) => {
  const actual = await original()
  const read = async (db) => (await db.query('SELECT cash')).rows[0]
  return { ...actual, calcularCaixa: read, calcularPainelMes: read, calcularFluxoCaixa: read, consultarLancamentos: read }
})
import { financeiroRoutes } from '../src/routes/financeiro.js'

beforeEach(() => _clearDashboardCache())
const urls = ['/v1/financeiro/caixa?ate=2026-10-07', '/v1/financeiro/painel?mes=2026-10',
  '/v1/financeiro/fluxo-caixa?mes=2026-10', '/v1/financeiro/lancamentos?inicio=2026-10&fim=2026-10']
async function buildApp(fail = false) {
  const app = Fastify()
  const query = vi.fn(async (sql) => {
    if (fail && sql === 'SELECT cash') throw Object.assign(new Error('Reconciliação necessária'), {
      statusCode: 409, code: 'FINANCIAL_RECONCILIATION_REQUIRED', divergencias: [],
    })
    return { rows: sql === 'SELECT cash' ? [{ total: 60 }] : [] }
  })
  const tenantParallel = vi.fn()
  app.decorate('tenantParallel', tenantParallel)
  app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: '00000000-0000-4000-8000-000000000003', papel: 'franqueado' } })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })
  await app.register(financeiroRoutes)
  return { app, query, tenantParallel }
}

describe('snapshot consistente dos consumidores de caixa', () => {
  it.each(urls)('%s usa BEGIN/COMMIT e cache hit não abre nova transação', async (url) => {
    const { app, query, tenantParallel } = await buildApp()
    try {
      expect((await app.inject({ method: 'GET', url })).json()).toEqual({ total: 60 })
      expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT cash', 'COMMIT'])
      expect(tenantParallel).not.toHaveBeenCalled()
      expect((await app.inject({ method: 'GET', url })).json()).toEqual({ total: 60 })
      expect(query).toHaveBeenCalledTimes(3)
    } finally { await app.close() }
  })
  it.each(urls)('%s faz ROLLBACK e retorna 409 sem cachear o erro', async (url) => {
    const { app, query, tenantParallel } = await buildApp(true)
    try {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(409)
      expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT cash', 'ROLLBACK'])
      expect(tenantParallel).not.toHaveBeenCalled()
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(409)
      expect(query).toHaveBeenCalledTimes(6)
    } finally { await app.close() }
  })
})
