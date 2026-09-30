import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import {
  dividirEmParcelas, gerarCustosDoMes, listarCustos, planejarGeracaoCustos, planejarParcelas,
  recorrenteVigenteNoMes, vencimentoRecorrente, parseIdVirtual, idVirtual,
} from '../src/services/custos-plano.js'
import { financeiroCustosRoutes } from '../src/routes/financeiro_custos.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const recId = '22222222-2222-4222-8222-222222222222'

const rec = {
  id: recId, nome: 'Aluguel', descricao: null, grupo: 'estrutural', valor: '3000.00',
  dia_vencimento: 31, mes_offset: 0, inicio: '2026-01-15', fim: null, ativo: true,
}

function fakeDb({ custos = [], recs = [rec] } = {}) {
  const calls = []
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql: String(sql), params })
    if (/FROM custos_recorrentes/.test(sql)) return { rows: recs }
    if (/FROM custos/.test(sql)) return { rows: custos }
    return { rows: [], rowCount: 0 }
  })
  return { query, calls }
}

describe('recorrentes', () => {
  it('vigência e vencimento com clamp de dia', () => {
    expect(recorrenteVigenteNoMes(rec, '2026-01')).toBe(true)
    expect(recorrenteVigenteNoMes(rec, '2025-12')).toBe(false)
    expect(recorrenteVigenteNoMes({ ...rec, fim: '2026-03-10' }, '2026-04')).toBe(false)
    expect(recorrenteVigenteNoMes({ ...rec, ativo: false }, '2026-02')).toBe(false)
    expect(vencimentoRecorrente(rec, '2026-02')).toBe('2026-02-28')
    expect(vencimentoRecorrente({ ...rec, dia_vencimento: 5, mes_offset: 1 }, '2026-12')).toBe('2027-01-05')
  })

  it('listarCustos inclui recorrente virtual do mês, não materializado', async () => {
    const db = fakeDb()
    const itens = await listarCustos(db, { tenantId, inicio: '2026-09', fim: '2026-10', hoje: '2026-09-30' })
    expect(itens).toHaveLength(2)
    expect(itens[0]).toMatchObject({
      id: idVirtual(recId, '2026-09'), natureza: 'custo', origem: 'recorrente', virtual: true,
      competencia: '2026-09-01', data_vencimento: '2026-09-30', valor_previsto: 3000, status: 'pendente',
    })
    expect(itens[1]).toMatchObject({ competencia: '2026-10-01', status: 'previsto' })
    expect(db.calls.every((c) => c.params[0] === tenantId && /tenant_id = \$1::uuid/.test(c.sql))).toBe(true)
  })

  it('não duplica virtual quando já materializado', async () => {
    const mat = {
      id: 'c1', descricao: 'Aluguel', valor: '3000.00', tipo: 'recorrente', grupo: 'estrutural',
      competencia: '2026-09-01', data_vencimento: '2026-09-30', valor_pago: '3000.00',
      data_pagamento: '2026-09-29', recorrente_id: recId,
    }
    const itens = await listarCustos(fakeDb({ custos: [mat] }), { tenantId, inicio: '2026-09', fim: '2026-09', hoje: '2026-09-30' })
    expect(itens).toHaveLength(1)
    expect(itens[0]).toMatchObject({ virtual: false, status: 'pago', origem: 'recorrente' })
  })

  it('geração é idempotente (plano e SQL)', async () => {
    const existentes = [{ recorrente_id: recId, competencia: '2026-09-01' }]
    expect(planejarGeracaoCustos({ mes: '2026-09', recorrentes: [rec], existentes }).inserir).toHaveLength(0)
    expect(planejarGeracaoCustos({ mes: '2026-10', recorrentes: [rec], existentes }).inserir).toHaveLength(1)

    const db = fakeDb()
    const r = await gerarCustosDoMes(db, { tenantId, mes: '2026-09' })
    const ins = db.calls.find((c) => /INSERT INTO custos/.test(c.sql))
    expect(ins.sql).toMatch(/ON CONFLICT \(recorrente_id, competencia\) DO NOTHING/)
    expect(ins.params[0]).toBe(tenantId)
    expect(r.mes).toBe('2026-09')
  })

  it('id virtual faz round trip', () => {
    expect(parseIdVirtual(idVirtual(recId, '2026-09'))).toEqual({ recorrente_id: recId, mes: '2026-09' })
    expect(parseIdVirtual('nope')).toBeNull()
  })
})

describe('parcelas', () => {
  it('10x: soma exata, competência e vencimento mensais', () => {
    const p = planejarParcelas({ n: 10, valor_total: 1000.01, data_vencimento: '2026-11-31'.replace('31', '30') })
    expect(p).toHaveLength(10)
    expect(Math.round(p.reduce((s, x) => s + x.valor, 0) * 100)).toBe(100001)
    expect(p[0]).toMatchObject({ parcela_num: 1, parcelas_total: 10, competencia: '2026-11-01' })
    expect(p[9]).toMatchObject({ parcela_num: 10, competencia: '2027-08-01', data_vencimento: '2027-08-30' })
  })

  it('dia 31 é ajustado ao último dia de cada mês', () => {
    const p = planejarParcelas({ n: 3, valor_parcela: 50, data_vencimento: '2026-01-31' })
    expect(p.map((x) => x.data_vencimento)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })

  it('dividirEmParcelas põe o resto na última', () => {
    expect(dividirEmParcelas(100, 3)).toEqual([33.33, 33.33, 33.34])
  })
})

describe('rotas', () => {
  function buildApp(query) {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => {
      request.user = { tenant_id: tenantId, sub: 'u1', papel: 'financeiro' }
    })
    app.decorate('withTenant', async (_t, fn) => fn({ query }))
    app.decorate('audit', { log: async () => {} })
    return app
  }

  it('POST parcelado insere 10 parcelas com tenant explícito e mesmo grupo', async () => {
    const inserts = []
    const query = vi.fn(async (sql, params) => {
      if (/gen_random_uuid/.test(sql)) return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }] }
      inserts.push(params)
      return { rows: [{
        id: 'x', descricao: params[1], valor: params[2], tipo: 'parcela', grupo: params[3],
        competencia: params[4], data_vencimento: params[5], valor_pago: null, data_pagamento: null,
        parcela_grupo_id: params[6], parcela_num: params[7], parcelas_total: params[8], recorrente_id: null,
      }] }
    })
    const app = buildApp(query)
    await app.register(financeiroCustosRoutes)
    const res = await app.inject({
      method: 'POST', url: '/v1/financeiro/custos/parcelado',
      payload: { descricao: 'Notebook', parcelas: 10, valor_total: 5000, data_vencimento: '2026-10-10' },
    })
    expect(res.statusCode).toBe(201)
    expect(inserts).toHaveLength(10)
    expect(inserts.every((p) => p[0] === tenantId && p[6] === '33333333-3333-4333-8333-333333333333')).toBe(true)
    const body = res.json()
    expect(body.parcelas[9]).toMatchObject({ parcela_num: 10, origem: 'parcela', status: 'previsto' })
    expect(body.parcelas[0].descricao).toBe('Notebook (1/10)')
  })

  it('valida grupo e exige valor_total XOR valor_parcela', async () => {
    const app = buildApp(vi.fn())
    await app.register(financeiroCustosRoutes)
    const a = await app.inject({ method: 'POST', url: '/v1/financeiro/custos', payload: { descricao: 'x', valor: 10, grupo: 'xpto', competencia: '2026-09' } })
    expect(a.statusCode).toBe(400)
    const b = await app.inject({ method: 'POST', url: '/v1/financeiro/custos/parcelado', payload: { descricao: 'x', parcelas: 2, competencia: '2026-09' } })
    expect(b.statusCode).toBe(400)
  })

  it('pagar item virtual materializa e baixa; status derivado pago', async () => {
    const query = vi.fn(async (sql, params) => {
      if (/FROM custos_recorrentes/.test(sql)) return { rows: [rec] }
      if (/^\s*INSERT INTO custos/.test(sql)) return { rows: [], rowCount: 1 }
      if (/SELECT id FROM custos/.test(sql)) return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }] }
      if (/UPDATE custos/.test(sql)) {
        expect(params[1]).toBe(tenantId)
        return { rows: [{
          id: params[0], descricao: 'Aluguel', valor: '3000.00', tipo: 'recorrente', grupo: 'estrutural',
          competencia: '2026-09-01', data_vencimento: '2026-09-30', valor_pago: '3000.00',
          data_pagamento: '2026-09-20', recorrente_id: recId,
        }] }
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(financeiroCustosRoutes)
    const res = await app.inject({
      method: 'PATCH', url: `/v1/financeiro/custos/${idVirtual(recId, '2026-09')}/pagar`,
      payload: { data_pagamento: '2026-09-20' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'pago', valor_pago: 3000, virtual: false })
  })
})
