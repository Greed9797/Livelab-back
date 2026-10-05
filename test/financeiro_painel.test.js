// Painel do mês (GET /painel): montarPainel (puro), calcularPainelMes e rota com db mockado,
// cache do agregador e equivalência da otimização de calcularImpostos (parâmetro `receitas`).
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  calcularImpostos, calcularPainelMes, listarLancamentos, montarPainel, projetarComissao, resumirAbertos,
} from '../src/services/financeiro-agregador.js'
import { listarReceitasAvulsas } from '../src/services/receitas-avulsas.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { _clearDashboardCache, invalidateTenant } from '../src/lib/dashboard-cache.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const HOJE = '2026-10-15'
const CONFIG = { data_corte: '2026-08-01', saldo_abertura: 1000 }
const REAL0 = { receitas: 0, avulsas: 0, aportes: 0, custos: 0, apresentadoras: 0, imposto: 0, entradas: 0, saidas: 0 }

const rec = (o) => ({
  natureza: 'receita', origem: 'avulsa', valor_previsto: 0, valor_pago: 0, data_pagamento: null, status: 'pendente',
  competencia: '2026-10-01', ...o,
})
const cus = (o) => ({ ...rec({ natureza: 'custo', origem: 'manual', grupo: 'estrutural' }), ...o })

const ITENS = [
  rec({ id: 'A', data_vencimento: '2026-09-10', valor_previsto: 100, competencia: '2026-09-01' }), // atrasado anterior
  rec({ id: 'B', origem: 'marca_comissao', data_vencimento: '2026-10-20', valor_previsto: 200 }), // no mês, a vencer
  rec({ id: 'C', data_vencimento: '2026-10-05', valor_previsto: 300, valor_pago: 100, data_pagamento: '2026-10-06', status: 'parcial' }),
  rec({ id: 'D', data_vencimento: '2026-10-08', valor_previsto: 500, perdido_em: '2026-10-09' }), // perdido: fora
  rec({ id: 'E', data_vencimento: '2026-11-02', valor_previsto: 999, competencia: '2026-11-01' }), // depois do fim do mês
  rec({ id: 'F', data_vencimento: '2026-07-30', valor_previsto: 777, competencia: '2026-07-01' }), // antes do corte
  cus({ id: 'G', data_vencimento: '2026-10-01', valor_previsto: 50 }),
  cus({ id: 'H', data_vencimento: '2026-10-03', valor_previsto: 80, cancelado_em: '2026-10-04' }), // cancelado: fora
  cus({ id: 'I', data_vencimento: '2026-10-25', valor_previsto: 40, competencia: '2026-10-01' }),
]

const painel = (o = {}) => montarPainel({
  mes: '2026-10', hoje: HOJE, config: CONFIG, itens: ITENS,
  realizadoAte: { ...REAL0, entradas: 700, saidas: 200 },
  realizadoPos: { ...REAL0, entradas: 10, saidas: 50 },
  realizadoMes: { ...REAL0, receitas: 150, avulsas: 50, aportes: 300, entradas: 500, saidas: 120 },
  ...o,
})

describe('montarPainel (puro)', () => {
  it('a_receber: no_mes × atrasado_anterior, atrasados (vence < hoje) e perdido fora', () => {
    const p = painel()
    // A(100, set) atrasado anterior; B(200, 20/10) a vencer; C(300−100 pago=200, 05/10) atrasado; D perdido, E depois do mês, F antes do corte
    expect(p.a_receber).toEqual({
      no_mes: 400, atrasado_anterior: 100, total: 500, qtd: 3, atrasados: { qtd: 2, valor: 300 },
    })
  })

  it('a_pagar: cancelado fora; atrasados só os vencidos antes de hoje', () => {
    expect(painel().a_pagar).toEqual({
      no_mes: 90, atrasado_anterior: 0, total: 90, qtd: 2, atrasados: { qtd: 1, valor: 50 },
    })
  })

  it('caixa, recebido/pago do mês e projetado_fim_mes', () => {
    const p = painel()
    expect(p).toMatchObject({
      mes: '2026-10', hoje: HOJE, fim_mes: '2026-10-31', mes_relativo: 'corrente', configurado: true,
      data_corte: '2026-08-01', saldo_abertura: 1000,
      caixa: { saldo_atual: 1500, ate: HOJE },
      recebido_mes: { total: 500, receitas: 200, aportes: 300 },
      pago_mes: { total: 120 },
    })
    // 1500 + 10 − 50 + 500 − 90
    expect(p.projetado_fim_mes).toBe(1870)
  })

  it('projeção de comissão fica fora dos totais reais; ritmo = projetado + ajuste', () => {
    const p = painel()
    // B: 200 em 15/31 dias → 413,33 (ajuste 213,33); vence 20/10 ≤ fim do mês
    expect(p.projecao_comissao).toEqual({
      competencia: '2026-10', previsto_atual: 200, projetado: 413.33, ajuste: 213.33,
      dias_decorridos: 15, dias_mes: 31, qtd: 1, vence_em: '2026-10-20', entra_no_painel: true,
    })
    expect(p.projetado_fim_mes).toBe(1870) // sem a projeção
    expect(p.projetado_fim_mes_ritmo).toBe(2083.33)
    expect(p.a_receber.total).toBe(500)
  })

  it('projeção: último dia do mês → projetado = previsto; vencimento depois do painel → não entra; pago/encerrado fora', () => {
    const fim = '2026-10-31'
    const c = (o) => rec({ origem: 'marca_comissao', valor_previsto: 100, data_vencimento: '2026-10-20', ...o })
    expect(projetarComissao({ itens: [c()], hoje: fim, fimMes: fim })).toMatchObject({ projetado: 100, ajuste: 0, dias_decorridos: 31 })
    const tarde = projetarComissao({ itens: [c({ data_vencimento: '2026-11-05' })], hoje: HOJE, fimMes: fim })
    expect(tarde).toMatchObject({ vence_em: '2026-11-05', entra_no_painel: false })
    expect(projetarComissao({ itens: [c({ valor_pago: 10 }), c({ perdido_em: '2026-10-01' })], hoje: HOJE, fimMes: fim })).toBeNull()
    const p = painel({ itens: [c({ data_vencimento: '2026-11-05' })] })
    expect(p.projetado_fim_mes_ritmo).toBeNull()
  })

  it('mês passado: ate = fim do mês, sem projeção de comissão nem ritmo', () => {
    const p = painel({ mes: '2026-09' })
    expect(p).toMatchObject({ mes_relativo: 'passado', fim_mes: '2026-09-30', caixa: { ate: '2026-09-30' } })
    expect(p.projecao_comissao).toBeNull()
    expect(p.projetado_fim_mes_ritmo).toBeNull()
    // A vence 10/09 (no mês), tudo que vence depois de 30/09 sai
    expect(p.a_receber).toMatchObject({ no_mes: 100, atrasado_anterior: 0, total: 100, qtd: 1 })
  })

  it('mês futuro: ate = hoje; atrasados contam só vencidos antes de hoje', () => {
    const p = painel({ mes: '2026-12', itens: [...ITENS, rec({ id: 'J', data_vencimento: '2026-12-10', valor_previsto: 60, competencia: '2026-12-01' })] })
    expect(p).toMatchObject({ mes_relativo: 'futuro', fim_mes: '2026-12-31', caixa: { ate: HOJE } })
    expect(p.a_receber.no_mes).toBe(60) // só J vence em dezembro
    expect(p.a_receber.atrasado_anterior).toBe(100 + 200 + 200 + 999) // A, B, C (aberto) e E vencem antes de dezembro
  })

  it('sem corte: configurado=false, caixa/projetado zerados, ritmo nulo', () => {
    const p = painel({ config: { data_corte: null, saldo_abertura: 500 } })
    expect(p).toMatchObject({
      configurado: false, data_corte: null, saldo_abertura: 0, caixa: { saldo_atual: 0, ate: HOJE },
      projetado_fim_mes: 0, projetado_fim_mes_ritmo: null,
    })
  })

  it('competencia é referência (DRE do mês) e não altera o a receber', () => {
    const p = painel()
    expect(p.competencia.receita.previsto).toBe(1000) // B + C + D (perdida conta cheia) = 200+300+500
    expect(p.competencia.receita.realizado).toBe(100)
    expect(p.competencia.custos).toEqual({ previsto: 90, realizado: 0 }) // G + I (H cancelado sai)
    expect(p.competencia.resultado).toEqual({ previsto: 1000 - 500 - 90, realizado: 100 })
  })

  it('resumirAbertos sem corte não tem piso', () => {
    const r = resumirAbertos([rec({ data_vencimento: '2020-01-01', valor_previsto: 10, competencia: '2020-01-01' })], { natureza: 'receita', mes: '2026-10', hoje: HOJE })
    expect(r).toMatchObject({ atrasado_anterior: 10, qtd: 1 })
  })
})

function mockDb(handlers = {}) {
  const query = vi.fn(async (sql, params) => {
    const s = String(sql)
    for (const [trecho, fn] of Object.entries(handlers)) if (s.includes(trecho)) return fn(s, params)
    return { rows: [] }
  })
  return { query }
}
const cfgRow = (corte = '2026-08-01') => ({ rows: [{ aliquota_imposto_pct: 10, data_corte: corte, saldo_abertura: '1000' }] })

describe('calcularPainelMes (banco mockado)', () => {
  it('janela única de lançamentos [mes−12m, mes]; 400 para mes inválido; tenant em toda query', async () => {
    const db = mockDb({
      financeiro_data_corte: () => cfgRow(),
      'FROM custos\n        WHERE': () => ({ rows: [
        { id: 'c1', descricao: 'Luz', valor: '120', tipo: 'outros', grupo: 'estrutural', competencia: '2026-10-01', data_vencimento: '2026-10-10', valor_pago: '0' },
      ] }),
    })
    const p = await calcularPainelMes(db, { tenantId: TENANT, mes: '2026-10', hoje: HOJE })
    expect(p.a_pagar).toMatchObject({ no_mes: 120, total: 120, qtd: 1, atrasados: { qtd: 1, valor: 120 } })
    const custosCalls = db.query.mock.calls.filter(([s]) => String(s).includes('FROM custos\n        WHERE'))
    expect(custosCalls).toHaveLength(1)
    expect(custosCalls[0][1]).toEqual([TENANT, '2025-10-01', '2026-10-31'])
    for (const [, params] of db.query.mock.calls) expect(params).toContain(TENANT)
    await expect(calcularPainelMes(db, { tenantId: TENANT, mes: '2026-13', hoje: HOJE })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('sem corte usa 12 meses anteriores ao mês do painel e não conta perdido/pago como aberto', async () => {
    const db = mockDb({
      financeiro_data_corte: () => cfgRow(null),
      'FROM receitas_avulsas\n      WHERE': () => ({ rows: [
        { id: 'aberto', descricao: 'Antigo', grupo: 'servico', valor_previsto: '100', valor_pago: '0', data_vencimento: '2025-11-10', competencia: '2025-11-01' },
        { id: 'perdido', descricao: 'Perdido', grupo: 'servico', valor_previsto: '200', valor_pago: '0', data_vencimento: '2025-12-10', competencia: '2025-12-01', perdido_em: '2026-01-01T00:00:00.000Z' },
        { id: 'pago', descricao: 'Pago', grupo: 'servico', valor_previsto: '300', valor_pago: '300', data_vencimento: '2026-01-10', data_pagamento: '2026-01-10', competencia: '2026-01-01' },
      ] }),
    })
    const p = await calcularPainelMes(db, { tenantId: TENANT, mes: '2026-10', hoje: HOJE })
    const calls = db.query.mock.calls.filter(([s]) => String(s).includes('FROM receitas_avulsas\n      WHERE'))
    expect(calls[0][1]).toEqual([TENANT, '2025-10-01', '2026-10-01'])
    expect(p.a_receber).toMatchObject({ atrasado_anterior: 100, total: 100, qtd: 1 })
    for (const [, params] of db.query.mock.calls) expect(params).toContain(TENANT)
  })

  it('projetado_fim_mes bate com saldo_projetado_fim_mes de /caixa (mesmos dados)', async () => {
    const { calcularCaixa } = await import('../src/services/financeiro-agregador.js')
    const mk = () => mockDb({
      financeiro_data_corte: () => cfgRow(),
      'FROM custos\n        WHERE': () => ({ rows: [
        { id: 'c1', descricao: 'Luz', valor: '120', tipo: 'outros', grupo: 'estrutural', competencia: '2026-10-01', data_vencimento: '2026-10-10', valor_pago: '0' },
      ] }),
      'FROM receitas_avulsas\n      WHERE': () => ({ rows: [
        { id: 'a1', descricao: 's', grupo: 'servico', valor_previsto: '900', valor_pago: '0', data_vencimento: '2026-10-28', data_pagamento: null, competencia: '2026-10-01' },
      ] }),
    })
    const p = await calcularPainelMes(mk(), { tenantId: TENANT, mes: '2026-10', hoje: HOJE })
    const c = await calcularCaixa(mk(), { tenantId: TENANT, hoje: HOJE })
    expect(p.projetado_fim_mes).toBe(c.saldo_projetado_fim_mes)
  })
})

describe('calcularImpostos com `receitas` já carregadas (equivalência)', () => {
  const avulsasRows = [
    { id: 'a1', descricao: 's', grupo: 'servico', valor_previsto: '1000', valor_pago: '0', data_vencimento: '2026-10-15', data_pagamento: null, competencia: '2026-10-01' },
    { id: 'a2', descricao: 'ap', grupo: 'aporte', valor_previsto: '9000', valor_pago: '0', data_vencimento: '2026-10-15', data_pagamento: null, competencia: '2026-10-01' },
    { id: 'a3', descricao: 'ago', grupo: 'servico', valor_previsto: '555', valor_pago: '0', data_vencimento: '2026-10-20', data_pagamento: null, competencia: '2026-08-01' },
    { id: 'a4', descricao: 'dez', grupo: 'servico', valor_previsto: '777', valor_pago: '0', data_vencimento: '2026-10-20', data_pagamento: null, competencia: '2026-12-01' },
  ]
  // honra o filtro de competência dos parâmetros ($2, $3), como o banco faria
  const mk = () => mockDb({
    financeiro_data_corte: () => cfgRow('2026-08-01'),
    'FROM receitas_avulsas\n      WHERE': (_s, p) => ({ rows: avulsasRows.filter((r) => r.competencia >= p[1] && r.competencia <= p[2]) }),
  })

  it('mesmo resultado com e sem itens carregados (janela maior que a necessária)', async () => {
    const inicio = '2026-11'
    const fim = '2026-11'
    const db = mk()
    const sem = await calcularImpostos(db, { tenantId: TENANT, inicio, fim, hoje: HOJE })
    const avulsas = await listarReceitasAvulsas(db, { tenantId: TENANT, inicio: '2026-08', fim: '2026-12', hoje: HOJE })
    const db2 = mk()
    const com = await calcularImpostos(db2, { tenantId: TENANT, inicio, fim, hoje: HOJE, receitas: { titulos: [], avulsas, inicio: '2026-08', fim: '2026-12' } })
    expect(com).toEqual(sem)
    expect(com[0]).toMatchObject({ base_tipo: 'projetado', base: 1000 })
    // com itens cobrindo a janela, não relista receitas/avulsas
    expect(db2.query.mock.calls.some(([s]) => String(s).includes('FROM receitas_avulsas\n      WHERE'))).toBe(false)
  })

  it('janela que não cobre cai na consulta (resultado idêntico)', async () => {
    const db = mk()
    const sem = await calcularImpostos(db, { tenantId: TENANT, inicio: '2026-11', fim: '2026-11', hoje: HOJE })
    const db2 = mk()
    const com = await calcularImpostos(db2, {
      tenantId: TENANT, inicio: '2026-11', fim: '2026-11', hoje: HOJE, receitas: { titulos: [], avulsas: [], inicio: '2026-11', fim: '2026-11' },
    })
    expect(com).toEqual(sem)
  })

  it('listarLancamentos lista receitas/avulsas uma vez só e preserva os itens', async () => {
    const db = mk()
    const itens = await listarLancamentos(db, { tenantId: TENANT, inicio: '2026-09', fim: '2026-11', hoje: HOJE })
    const chamadas = db.query.mock.calls.filter(([s]) => String(s).includes('FROM receitas_avulsas\n      WHERE'))
    expect(chamadas).toHaveLength(1)
    const imposto = itens.find((i) => i.origem === 'imposto' && i.competencia === '2026-11-01')
    expect(imposto).toMatchObject({ base: 1000, valor_previsto: 100 })
  })
})

describe('rotas: painel, dre e cache do agregador', () => {
  beforeEach(() => _clearDashboardCache())

  function buildApp(db) {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: TENANT, papel: 'franqueado', sub: null } })
    app.decorate('withTenant', async (_t, fn) => fn(db))
    app.decorate('audit', { log: async () => {} })
    return app
  }

  it('GET /painel: 200 com o contrato, 400 para mes inválido, 2ª chamada vem do cache', async () => {
    const db = mockDb({ financeiro_data_corte: () => cfgRow() })
    const app = buildApp(db)
    await app.register(financeiroRoutes)
    const r1 = await app.inject({ method: 'GET', url: '/v1/financeiro/painel?mes=2026-10' })
    expect(r1.statusCode).toBe(200)
    expect(r1.headers['x-dashboard-cache']).toBe('MISS')
    expect(r1.headers['cache-control']).toBe('private, no-cache')
    expect(Object.keys(r1.json())).toEqual(expect.arrayContaining([
      'mes', 'hoje', 'fim_mes', 'mes_relativo', 'configurado', 'data_corte', 'saldo_abertura', 'caixa', 'recebido_mes',
      'pago_mes', 'a_receber', 'a_pagar', 'projetado_fim_mes', 'projecao_comissao', 'projetado_fim_mes_ritmo', 'competencia',
    ]))
    const chamadas = db.query.mock.calls.length
    const r2 = await app.inject({ method: 'GET', url: '/v1/financeiro/painel?mes=2026-10' })
    expect(r2.headers['x-dashboard-cache']).toBe('HIT')
    expect(r2.json()).toEqual(r1.json())
    expect(db.query.mock.calls.length).toBe(chamadas)
    // mes diferente = chave diferente
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/painel?mes=2026-09' })).headers['x-dashboard-cache']).toBe('MISS')
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/painel?mes=2026-13' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/painel?mes=abc' })).statusCode).toBe(400)
    // invalidação do tenant → recomputa
    invalidateTenant(TENANT)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/painel?mes=2026-10' })).headers['x-dashboard-cache']).toBe('MISS')
    await app.close()
  })

  it('GET /dre devolve só o DRE por período (sem bloco legado) e valida o período', async () => {
    const db = mockDb({ financeiro_data_corte: () => cfgRow(null) })
    const app = buildApp(db)
    await app.register(financeiroRoutes)
    const r = await app.inject({ method: 'GET', url: '/v1/financeiro/dre?inicio=2026-01&fim=2026-03' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toMatchObject({ inicio: '2026-01', fim: '2026-03', aliquota: 10, data_corte: null })
    expect(body.meses).toHaveLength(3)
    expect(body.meses.map((m) => m.caixa)).toEqual([
      { saldo_inicio_mes: null }, { saldo_inicio_mes: null }, { saldo_inicio_mes: null },
    ])
    expect(body.totais).toBeDefined()
    expect(body).not.toHaveProperty('fat_bruto')
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/dre?inicio=2026-05&fim=2026-01' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/dre?inicio=x' })).statusCode).toBe(400)
    await app.close()
  })

  it('GET /dre inclui caixa.saldo_inicio_mes em cada mês; preserva zero configurado', async () => {
    const db = mockDb({
      financeiro_data_corte: () => ({ rows: [{ aliquota_imposto_pct: 10, data_corte: '2026-02-15', saldo_abertura: '0' }] }),
      'WITH meses AS': () => ({ rows: [
        { mes: '2026-02', saldo_inicio_mes: '0' },
        { mes: '2026-03', saldo_inicio_mes: '125.50' },
      ] }),
    })
    const app = buildApp(db)
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/dre?inicio=2026-01&fim=2026-03' })
    expect(res.statusCode).toBe(200)
    expect(res.json().meses.map((m) => [m.mes, m.caixa])).toEqual([
      ['2026-01', { saldo_inicio_mes: null }],
      ['2026-02', { saldo_inicio_mes: 0 }],
      ['2026-03', { saldo_inicio_mes: 125.5 }],
    ])
    expect(db.query.mock.calls.filter(([sql]) => String(sql).includes('WITH meses AS'))).toHaveLength(1)
    await app.close()
  })

  it('caixa, lancamentos, dre/mes e fluxo-caixa usam o cache; lançamentos distingue filtros', async () => {
    const db = mockDb({ financeiro_data_corte: () => cfgRow(null) })
    const app = buildApp(db)
    await app.register(financeiroRoutes)
    for (const url of [
      '/v1/financeiro/caixa', '/v1/financeiro/lancamentos?mes=2026-10', '/v1/financeiro/dre/mes?mes=2026-10',
      '/v1/financeiro/fluxo-caixa?mes=2026-10',
    ]) {
      expect((await app.inject({ method: 'GET', url })).headers['x-dashboard-cache'], url).toBe('MISS')
      expect((await app.inject({ method: 'GET', url })).headers['x-dashboard-cache'], url).toBe('HIT')
    }
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?mes=2026-10&natureza=custo' })).headers['x-dashboard-cache']).toBe('MISS')
    await app.close()
  })
})
