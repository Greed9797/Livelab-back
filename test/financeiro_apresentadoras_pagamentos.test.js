import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { financeiroApresentadorasPagamentosRoutes } from '../src/routes/financeiro_apresentadoras_pagamentos.js'
import { listarPagamentosApresentadoras, mesesDoPeriodo, vencimentoApresentadora } from '../src/services/apresentadoras-pagamentos.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const apId = '22222222-2222-4222-8222-222222222222'

// Roteia as queries do serviço por trecho de SQL.
function fakeDb({ pagos = [], config = { dia: 10, mes_offset: 1 }, fixo = '2700.00', comissao = '160.00' } = {}) {
  const calls = []
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql: String(sql), params })
    const s = String(sql)
    if (s.includes('DELETE FROM apresentadora_pagamentos')) return { rowCount: 1, rows: [{ id: 'x' }] }
    if (s.includes('FROM tenants')) return { rows: [config] }
    if (s.includes('FROM apresentadora_pagamentos')) return { rows: pagos }
    if (s.includes('apresentadora_remuneracao_adicionais')) return { rows: [] }
    if (s.includes('FROM vendas_atribuidas')) return { rows: [{ apresentadora_id: apId, nome: 'Ana', valor: comissao }] }
    if (s.includes('FROM apresentadoras a') && s.includes('prorate') === false && s.includes('a.ativo')) return { rows: [{ apresentadora_id: apId, nome: 'Ana', valor: fixo }] }
    if (s.includes('SELECT id FROM apresentadoras')) return { rows: [{ id: apId }] }
    if (s.includes('INSERT INTO apresentadora_pagamentos')) return { rows: [{ apresentadora_id: apId, valor_pago: params[3] }] }
    return { rows: [] }
  })
  return { query, calls }
}

describe('vencimento', () => {
  it('usa o dia configurado no mês seguinte e vira o ano', () => {
    expect(vencimentoApresentadora('2026-09', 10, 1)).toBe('2026-10-10')
    expect(vencimentoApresentadora('2026-12', 10, 1)).toBe('2027-01-10')
    expect(vencimentoApresentadora('2026-09', 5, 0)).toBe('2026-09-05')
  })
  it('dia maior que o fim do mês cai no último dia', () => {
    expect(vencimentoApresentadora('2026-01', 31, 1)).toBe('2026-02-28')
    expect(vencimentoApresentadora('2027-12', 31, 2 - 1)).toBe('2028-01-31')
    expect(vencimentoApresentadora('2027-01', 30, 1)).toBe('2027-02-28')
    expect(vencimentoApresentadora('2028-01', 30, 1)).toBe('2028-02-29')
  })
  it('lista meses do período', () => {
    expect(mesesDoPeriodo('2026-11-15', '2027-01-02')).toEqual(['2026-11', '2026-12', '2027-01'])
  })
})

describe('listarPagamentosApresentadoras', () => {
  const base = { tenantId, inicio: '2026-09-01', fim: '2026-09-30' }

  it('usa o total do fechamento e devolve o formato da spec', async () => {
    const db = fakeDb()
    const [item] = await listarPagamentosApresentadoras(db, { ...base, hoje: '2026-10-05' })
    expect(item).toMatchObject({
      id: `apresentadora:${apId}:2026-09`, natureza: 'custo', origem: 'apresentadora',
      competencia: '2026-09-01', data_vencimento: '2026-10-10', valor_previsto: 2860, valor_pago: 0,
      data_pagamento: null, status: 'pendente',
    })
  })

  it('deriva status: atrasado, parcial e pago', async () => {
    const atrasado = await listarPagamentosApresentadoras(fakeDb(), { ...base, hoje: '2026-10-11' })
    expect(atrasado[0].status).toBe('atrasado')
    const parcial = await listarPagamentosApresentadoras(
      fakeDb({ pagos: [{ apresentadora_id: apId, competencia: '2026-09-01', valor_pago: '1000.00', data_pagamento: '2026-10-05' }] }),
      { ...base, hoje: '2026-10-06' })
    expect(parcial[0]).toMatchObject({ status: 'parcial', valor_pago: 1000, data_pagamento: '2026-10-05' })
    const pago = await listarPagamentosApresentadoras(
      fakeDb({ pagos: [{ apresentadora_id: apId, competencia: '2026-09-01', valor_pago: '2860.00', data_pagamento: '2026-10-05' }] }),
      { ...base, hoje: '2026-11-20' })
    expect(pago[0].status).toBe('pago')
  })

  it('mês futuro fica previsto e respeita config do tenant', async () => {
    const db = fakeDb({ config: { dia: 31, mes_offset: 1 } })
    const [item] = await listarPagamentosApresentadoras(db, { tenantId, inicio: '2026-12-01', fim: '2026-12-31', hoje: '2026-09-30' })
    expect(item.status).toBe('previsto')
    expect(item.data_vencimento).toBe('2027-01-31')
  })

  it('passa tenant_id explícito em todas as queries', async () => {
    const db = fakeDb()
    await listarPagamentosApresentadoras(db, { ...base, hoje: '2026-09-30' })
    for (const c of db.calls) expect(c.params[0]).toBe(tenantId)
    for (const c of db.calls) expect(c.sql).toMatch(/tenant_id|id = \$1/)
  })
})

describe('rotas', () => {
  function buildApp(db) {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => {
      request.user = { tenant_id: tenantId, sub: '44444444-4444-4444-8444-444444444444', papel: 'financeiro' }
    })
    app.decorate('withTenant', async (t, fn) => { expect(t).toBe(tenantId); return fn(db) })
    app.register(financeiroApresentadorasPagamentosRoutes)
    return app
  }
  const url = `/v1/financeiro/apresentadoras-pagamentos/${apId}/2026-09`

  it('pagar sem corpo paga o total do fechamento', async () => {
    const db = fakeDb()
    const res = await buildApp(db).inject({ method: 'PATCH', url: `${url}/pagar`, payload: {} })
    expect(res.statusCode).toBe(200)
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO apresentadora_pagamentos'))
    expect(ins.params[0]).toBe(tenantId)
    expect(ins.params[3]).toBe(2860)
  })

  it('pagar parcial grava o valor informado', async () => {
    const db = fakeDb()
    const res = await buildApp(db).inject({ method: 'PATCH', url: `${url}/pagar`, payload: { valor_pago: '1000,50', data_pagamento: '2026-10-05' } })
    expect(res.statusCode).toBe(200)
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO apresentadora_pagamentos'))
    expect(ins.params[3]).toBe(1000.5)
    expect(ins.params[4]).toBe('2026-10-05')
  })

  it('rejeita valor inválido, mês inválido e data inexistente', async () => {
    const app = buildApp(fakeDb())
    expect((await app.inject({ method: 'PATCH', url: `${url}/pagar`, payload: { valor_pago: '-5' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `${url}/pagar`, payload: { data_pagamento: '2026-02-31' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/apresentadoras-pagamentos/${apId}/2026-13/pagar`, payload: {} })).statusCode).toBe(400)
  })

  it('desfazer remove a baixa; config valida dia', async () => {
    const db = fakeDb()
    const app = buildApp(db)
    expect((await app.inject({ method: 'PATCH', url: `${url}/desfazer` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/apresentadoras-pagamentos/config', payload: { dia: 32 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/apresentadoras-pagamentos/config', payload: { dia: 15 } })).statusCode).toBe(200)
  })
})
