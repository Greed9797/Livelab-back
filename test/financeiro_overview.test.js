import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/financeiro-agregador.js', async (importOriginal) => {
  const original = await importOriginal()
  return { ...original, listarLancamentos: vi.fn() }
})

import { listarLancamentos } from '../src/services/financeiro-agregador.js'
import { financeiroOverviewRoutes } from '../src/routes/financeiro_overview.js'

const URL = '/v1/financeiro/overview?mes=2026-10&data_referencia=2026-10-10'

function obligation(id, overrides = {}) {
  return {
    id, natureza: 'receita', origem: 'avulsa', componente: null,
    competencia: '2026-10-01', data_vencimento: '2026-10-09',
    data_pagamento: null, status: 'pendente', valor_previsto: '0.30',
    valor_pago: '0.10', virtual: false, ...overrides,
  }
}

async function appFor(role = 'financeiro_readonly') {
  const app = Fastify()
  const queries = []
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(role)) return reply.code(403).send({ error: 'forbidden' })
    request.user = { tenant_id: 'tenant-a', papel: role }
  })
  app.decorate('withTenant', async (tenantId, fn) => fn({
    tenantId, query: async (sql) => { queries.push(sql) },
  }))
  await app.register(financeiroOverviewRoutes)
  return { app, queries }
}

describe('FIN-05 overview and exception queue', () => {
  it('returns exact totals and only overdue eligible obligations', async () => {
    listarLancamentos.mockResolvedValue([
      obligation('a'),
      obligation('b', { natureza: 'custo', valor_previsto: '0.20', valor_pago: '0.00', data_vencimento: '2026-10-10' }),
      obligation('c', { valor_previsto: '0.10', valor_pago: '0.00', data_vencimento: '2026-10-11' }),
    ])
    const { app, queries } = await appFor()
    const overview = await app.inject({ url: URL })
    expect(overview.statusCode).toBe(200)
    expect(overview.json()).toMatchObject({
      estado: 'apurado', total_excecoes: 1,
      totais: { receber: { quantidade: 2, previsto: '0.40', pago: '0.10', aberto: '0.30' },
        pagar: { quantidade: 1, previsto: '0.20', pago: '0.00', aberto: '0.20' } },
    })
    const queue = await app.inject({ url: URL.replace('overview', 'exceptions') })
    expect(queue.statusCode).toBe(200)
    expect(queue.json()).toMatchObject({ total_registros: 1, itens: [{ tipo: 'vencido', id: 'a', saldo_aberto: '0.20' }] })
    expect(listarLancamentos).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }), expect.objectContaining({ tenantId: 'tenant-a', inicio: '2026-10', fim: '2026-10' }))
    expect(queries).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT',
    ])
    await app.close()
  })

  it('marks duplicate and virtual records incomplete rather than presenting partial totals', async () => {
    listarLancamentos.mockResolvedValue([
      obligation('same'), obligation('same'), obligation('virtual', { virtual: true }),
    ])
    const { app } = await appFor()
    const overview = (await app.inject({ url: URL })).json()
    expect(overview).toMatchObject({ estado: 'incompleto', incompletos: 3, totais: null, total_excecoes: 3 })
    const queue = (await app.inject({ url: URL.replace('overview', 'exceptions') + '&limite=2&pagina=2' })).json()
    expect(queue).toMatchObject({ total_registros: 3, pagina: 2, total_paginas: 2 })
    expect(queue.itens).toHaveLength(1)
    await app.close()
  })

  it('validates filters and rejects unauthorized access before opening a connection', async () => {
    listarLancamentos.mockResolvedValue([])
    const { app, queries } = await appFor()
    expect((await app.inject({ url: URL })).json()).toMatchObject({ estado: 'vazio', totais: null, total_excecoes: 0 })
    queries.length = 0
    expect((await app.inject({ url: URL.replace('2026-10-10', '2026-02-30') })).statusCode).toBe(400)
    expect((await app.inject({ url: URL + '&unknown=1' })).statusCode).toBe(400)
    expect(queries).toEqual([])
    await app.close()
    const denied = await appFor('apresentador')
    expect((await denied.app.inject({ url: URL })).statusCode).toBe(403)
    await denied.app.close()
  })
})
