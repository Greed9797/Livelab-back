import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/financeiro-agregador.js', async (importOriginal) => {
  const original = await importOriginal()
  return { ...original, listarLancamentos: vi.fn() }
})

import { listarLancamentos } from '../src/services/financeiro-agregador.js'
import { financeiroAgingRoutes } from '../src/routes/financeiro_aging.js'
import { parseAgingQuery } from '../src/services/financeiro-aging.js'

const URL = '/v1/financeiro/aging?data_referencia=2026-10-10&competencia_inicio=2026-09&competencia_fim=2026-10&faixas=7,30'

function item(id, due, overrides = {}) {
  return {
    id, natureza: 'receita', origem: 'avulsa', componente: null, status: 'atrasado',
    competencia: '2026-09-01', data_vencimento: due, data_pagamento: null,
    valor_previsto: 0.01, valor_pago: 0, virtual: false,
    ...overrides,
  }
}

async function appFor({ role = 'financeiro_readonly', tenantId = 'tenant-a' } = {}) {
  const app = Fastify()
  const queries = []
  const tenants = []
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(role)) return reply.code(403).send({ error: 'forbidden' })
    request.user = { tenant_id: tenantId, papel: role }
  })
  app.decorate('withTenant', async (tenant, fn) => {
    tenants.push(tenant)
    return fn({ tenantId: tenant, query: async (sql) => { queries.push(sql) } })
  })
  app.agingQueries = queries
  app.agingTenants = tenants
  await app.register(financeiroAgingRoutes)
  return app
}

describe('FIN-06A aging', () => {
  it('atribui cada saldo exato uma vez a faixas disjuntas nos limites', async () => {
    listarLancamentos.mockResolvedValue([
      item('d1', '2026-10-09', { valor_previsto: 0.1 }),
      item('d7', '2026-10-03', { valor_previsto: 0.2, valor_pago: 0.1 }),
      item('d8', '2026-10-02', { valor_previsto: 0.3 }),
      item('d30', '2026-09-10', { valor_previsto: 0.4 }),
      item('d31', '2026-09-09', { valor_previsto: 0.5 }),
      item('today', '2026-10-10', { valor_previsto: 1, status: 'pendente' }),
      item('future', '2026-10-11', { valor_previsto: 2, status: 'pendente' }),
      item('other-month', '2026-08-01', { competencia: '2026-08-01', valor_previsto: 100 }),
    ])
    const app = await appFor()
    const response = await app.inject({ method: 'GET', url: URL })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data_referencia: '2026-10-10', limites_dias: [7, 30],
      atrasado: { quantidade: 5, saldo_aberto: '1.40' },
      vence_hoje: { quantidade: 1, saldo_aberto: '1.00' },
      futuro: { quantidade: 1, saldo_aberto: '2.00' },
      faixas: [
        { de_dias: 1, ate_dias: 7, quantidade: 2, saldo_aberto: '0.20' },
        { de_dias: 8, ate_dias: 30, quantidade: 2, saldo_aberto: '0.70' },
        { de_dias: 31, ate_dias: null, quantidade: 1, saldo_aberto: '0.50' },
      ],
    })
    expect(app.agingQueries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT'])
    expect(app.agingTenants).toEqual(['tenant-a'])
    expect(listarLancamentos).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }), expect.objectContaining({ tenantId: 'tenant-a', inicio: '2026-09', fim: '2026-10', hoje: '2026-10-10' }))
    await app.close()
  })

  it('omite encerrados, pagos, virtuais, sem vencimento e identidades ambíguas', async () => {
    listarLancamentos.mockResolvedValue([
      item('good', '2026-10-09', { valor_previsto: 1 }),
      item('lost', '2026-10-01', { status: 'perdido', perdido_em: '2026-10-02', valor_previsto: 10 }),
      item('cancelled', '2026-10-01', { natureza: 'custo', status: 'cancelado', cancelado_em: '2026-10-02', valor_previsto: 10 }),
      item('paid', '2026-10-01', { status: 'pago', valor_previsto: 10, valor_pago: 10 }),
      item('virtual', '2026-10-01', { virtual: true, valor_previsto: 10 }),
      item('apuracao', '2026-10-01', { em_apuracao: true, valor_previsto: 10 }),
      item('undated', null, { valor_previsto: 10 }),
      item(null, '2026-10-01', { valor_previsto: 10 }),
      item('overpaid', '2026-10-01', { valor_previsto: 1, valor_pago: 2 }),
      item('duplicate', '2026-10-01', { valor_previsto: 10 }),
      item('duplicate', '2026-10-01', { valor_previsto: 10 }),
    ])
    const app = await appFor()
    const result = (await app.inject({ method: 'GET', url: URL })).json()
    expect(result.atrasado).toEqual({ quantidade: 1, saldo_aberto: '1.00' })
    expect(result.faixas.reduce((sum, row) => sum + row.quantidade, 0)).toBe(1)
    await app.close()
  })

  it('rejeita parâmetros inválidos antes de abrir conexão e exige papel/tenant', async () => {
    listarLancamentos.mockResolvedValue([])
    const app = await appFor()
    for (const url of [
      URL.replace('2026-10-10', '2026-02-30'),
      URL.replace('2026-09', '2026-13'),
      URL.replace('2026-09', '2022-09'),
      URL.replace('faixas=7,30', 'faixas=30,7'),
      URL.replace('faixas=7,30', 'faixas=7,7'),
      URL.replace('faixas=7,30', 'faixas=0,7'),
      URL.replace('faixas=7,30', 'faixas=7.5'),
      `${URL}&x=1`,
      `${URL}&faixas=60`,
    ]) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400)
    expect(app.agingTenants).toEqual([])
    await app.close()
    const denied = await appFor({ role: 'apresentador' })
    expect((await denied.inject({ method: 'GET', url: URL })).statusCode).toBe(403)
    await denied.close()
    const noTenant = await appFor({ tenantId: null })
    expect((await noTenant.inject({ method: 'GET', url: URL })).statusCode).toBe(403)
    expect(noTenant.agingTenants).toEqual([])
    await noTenant.close()
    expect(() => parseAgingQuery({ data_referencia: '2026-10-10', competencia_inicio: '2026-09', competencia_fim: '2026-10' })).toThrow(/faixas/)
  })

  it('faz rollback quando a leitura falha', async () => {
    listarLancamentos.mockRejectedValue(new Error('read failed'))
    const app = await appFor()
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(500)
    expect(app.agingQueries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK'])
    await app.close()
  })
})
