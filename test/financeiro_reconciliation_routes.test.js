import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/financeiro-read-snapshot.js', () => ({
  lerSnapshotFinanceiro: async () => {
    throw Object.assign(new Error('Reconciliação necessária'), {
      statusCode: 409, code: 'FINANCIAL_RECONCILIATION_REQUIRED',
      divergencias: [{ origem_tipo: 'receita_titulo', origem_id: '00000000-0000-4000-8000-000000000001', motivo: 'saldo_divergente', valor: 'private' }],
    })
  },
}))
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { financeiroReceitasRoutes } from '../src/routes/financeiro_receitas.js'

describe('reconciliação nas respostas autenticadas', () => {
  it.each([
    ['/v1/financeiro/receita?mes=2026-10', financeiroReceitasRoutes],
    ['/v1/financeiro/dre?inicio=2026-10&fim=2026-10', financeiroRoutes],
    ['/v1/financeiro/dre/mes?mes=2026-10', financeiroRoutes],
    ['/v1/financeiro/caixa?ate=2026-10-07', financeiroRoutes],
    ['/v1/financeiro/painel?mes=2026-10', financeiroRoutes],
    ['/v1/financeiro/fluxo-caixa?mes=2026-10', financeiroRoutes],
    ['/v1/financeiro/lancamentos?inicio=2026-10&fim=2026-10', financeiroRoutes],
  ])('%s preserva referência sem expor valores ou SQL', async (url, routes) => {
    const app = Fastify()
    const auth = async (request) => { request.user = { tenant_id: '00000000-0000-4000-8000-000000000002', papel: 'franqueado' } }
    app.decorate('authenticate', auth)
    app.decorate('requirePapel', () => auth)
    app.decorate('withTenant', async (_tenant, fn) => fn({ query: async () => ({ rows: [] }) }))
    app.decorate('audit', { log: async () => {} })
    await app.register(routes)
    try {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'Reconciliação necessária', code: 'FINANCIAL_RECONCILIATION_REQUIRED',
        divergencias: [{ origem_tipo: 'receita_titulo', origem_id: '00000000-0000-4000-8000-000000000001', motivo: 'saldo_divergente' }] })
    } finally { await app.close() }
  })
})
