// Agregador do financeiro (onda 2): lançamentos unificados, imposto, DRE e fluxo de caixa.
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import {
  calcularImpostoMes,
  calcularImpostos,
  chaveFluxo,
  faixaDoDia,
  filtrarLancamentos,
  listarLancamentos,
  montarDre,
  montarFluxoCaixa,
  montarItemImposto,
  normalizarApresentadora,
  normalizarCusto,
  normalizarReceita,
  parseIdImposto,
  previstoReceitaPorVencimento,
  resolverPeriodoMeses,
  totalizarLancamentos,
  vencimentoImposto,
} from '../src/services/financeiro-agregador.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const HOJE = '2026-09-15'

const receita = (over = {}) => normalizarReceita({
  id: 'calc:m:2026-09:fixo', componente: 'fixo', materializado: false, descricao: 'Fixo — A',
  competencia: '2026-09-01', data_vencimento: '2026-10-05', valor_previsto: 1000, valor_pago: 0, data_pagamento: null,
  ...over,
}, HOJE)
const custo = (over = {}) => normalizarCusto({
  id: 'c1', origem: 'manual', descricao: 'Aluguel', grupo: 'estrutural', tipo: 'outros',
  competencia: '2026-09-01', data_vencimento: '2026-09-10', valor_previsto: 300, valor_pago: null, data_pagamento: null,
  ...over,
}, HOJE)

describe('período', () => {
  it('aceita inicio/fim, mes, mes+ano e default = mês corrente (SP)', () => {
    expect(resolverPeriodoMeses({ inicio: '2026-01', fim: '2026-03' }, HOJE)).toEqual({ inicio: '2026-01', fim: '2026-03' })
    expect(resolverPeriodoMeses({ inicio: '2026-05-01', fim: '2026-05-31' }, HOJE)).toEqual({ inicio: '2026-05', fim: '2026-05' })
    expect(resolverPeriodoMeses({ mes: '2026-07' }, HOJE)).toEqual({ inicio: '2026-07', fim: '2026-07' })
    expect(resolverPeriodoMeses({ mes: '4', ano: '2026' }, HOJE)).toEqual({ inicio: '2026-04', fim: '2026-04' })
    expect(resolverPeriodoMeses({}, HOJE)).toEqual({ inicio: '2026-09', fim: '2026-09' })
    expect(() => resolverPeriodoMeses({ inicio: '2026-05', fim: '2026-04' }, HOJE)).toThrow(/fim/)
    expect(() => resolverPeriodoMeses({ inicio: '2020-01', fim: '2026-01' }, HOJE)).toThrow(/máximo/)
  })
})

describe('status derivado e normalização', () => {
  it('receita: origem marca_fixo/marca_comissao, virtual quando não materializada, status derivado', () => {
    const r = receita()
    expect(r).toMatchObject({ natureza: 'receita', origem: 'marca_fixo', virtual: true, status: 'previsto', valor_pago: 0 })
    const atrasada = receita({ componente: 'comissao', materializado: true, data_vencimento: '2026-09-05' })
    expect(atrasada).toMatchObject({ origem: 'marca_comissao', virtual: false, status: 'atrasado' })
    expect(receita({ valor_pago: 400, data_pagamento: '2026-09-10', data_vencimento: '2026-09-20' }).status).toBe('parcial')
    expect(receita({ valor_pago: 1000, data_pagamento: '2026-09-10' }).status).toBe('pago')
  })

  it('custo: valor_pago null vira 0; pendente no mês corrente; apresentadora com grupo próprio', () => {
    expect(custo({ data_vencimento: '2026-09-20' })).toMatchObject({ valor_pago: 0, status: 'pendente' })
    expect(custo()).toMatchObject({ status: 'atrasado' })
    const ap = normalizarApresentadora({
      id: 'apresentadora:a:2026-09', apresentadora_id: 'a', descricao: 'Pagamento Ana', competencia: '2026-09-01',
      data_vencimento: '2026-10-10', valor_previsto: 2500, valor_pago: 0, data_pagamento: null,
    }, HOJE)
    expect(ap).toMatchObject({ natureza: 'custo', origem: 'apresentadora', grupo: 'apresentadoras', status: 'previsto', virtual: true })
  })

  it('filtros natureza/status/grupo/q (sem acento) e totais', () => {
    const itens = [
      receita(),
      receita({ id: 'r2', descricao: 'Comissão — Marca Ótica', componente: 'comissao', data_vencimento: '2026-09-05', valor_previsto: 500, valor_pago: 200, data_pagamento: '2026-09-06' }),
      custo(),
      custo({ id: 'c2', descricao: 'Internet', grupo: 'ferramentas', valor_previsto: 100, valor_pago: 100, data_pagamento: '2026-09-09' }),
    ]
    expect(filtrarLancamentos(itens, { natureza: 'custo' })).toHaveLength(2)
    expect(filtrarLancamentos(itens, { status: 'atrasado' }).map((i) => i.id)).toEqual(['r2', 'c1'])
    expect(filtrarLancamentos(itens, { grupo: 'ferramentas' }).map((i) => i.id)).toEqual(['c2'])
    expect(filtrarLancamentos(itens, { q: 'otica' }).map((i) => i.id)).toEqual(['r2'])
    expect(totalizarLancamentos(itens)).toEqual({
      receita: { previsto: 1500, pago: 200, atrasado: 300, pendente: 1000, perdido: 0 },
      custo: { previsto: 400, pago: 100, atrasado: 300, pendente: 0, cancelado: 0 },
      aportes: { previsto: 0, pago: 0 },
      saldo_previsto: 1100,
      saldo_realizado: 100,
    })
  })
})

describe('imposto', () => {
  it('base = recebido em M-1 quando M-1 fechou; vence dia 20 de M', () => {
    const c = calcularImpostoMes({ mes: '2026-09', mesAtual: '2026-09', aliquota: 10, recebidoAnterior: 12345.67, previstoAnterior: 99999 })
    expect(c).toMatchObject({ mes_base: '2026-08', base: 12345.67, base_tipo: 'realizado', valor: 1234.57 })
    expect(vencimentoImposto('2026-09')).toBe('2026-09-20')
    expect(vencimentoImposto('2026-02')).toBe('2026-02-20')
  })

  it('meses futuros projetam sobre o previsto de M-1 (nunca abaixo do já recebido)', () => {
    const futuro = calcularImpostoMes({ mes: '2026-11', mesAtual: '2026-09', aliquota: 6, recebidoAnterior: 0, previstoAnterior: 5000 })
    expect(futuro).toMatchObject({ mes_base: '2026-10', base: 5000, base_tipo: 'projetado', valor: 300 })
    const corrente = calcularImpostoMes({ mes: '2026-10', mesAtual: '2026-09', aliquota: 10, recebidoAnterior: 800, previstoAnterior: 500 })
    expect(corrente).toMatchObject({ base: 800, base_tipo: 'projetado', valor: 80 })
  })

  it('previsto de M-1 é por mês de VENCIMENTO', () => {
    const mapa = previstoReceitaPorVencimento([
      { data_vencimento: '2026-10-05', valor_previsto: 100 },
      { data_vencimento: '2026-10-31', valor_previsto: 50.005 },
      { data_vencimento: '2026-11-05', valor_previsto: 10 },
    ])
    expect(mapa.get('2026-10')).toBe(150.01)
    expect(mapa.get('2026-11')).toBe(10)
  })

  it('item: id imposto:<mes>, virtual sem baixa; materializado usa valor gravado', () => {
    const calculo = calcularImpostoMes({ mes: '2026-09', mesAtual: '2026-09', aliquota: 10, recebidoAnterior: 1000 })
    const virtual = montarItemImposto({ calculo, hoje: HOJE })
    expect(virtual).toMatchObject({ id: 'imposto:2026-09', origem: 'imposto', grupo: 'imposto', natureza: 'custo', virtual: true, valor_previsto: 100, data_vencimento: '2026-09-20', status: 'pendente' })
    const pago = montarItemImposto({ calculo, materializado: { id: 'x', valor: '95', valor_pago: '95', data_pagamento: '2026-09-18', data_vencimento: '2026-09-20' }, hoje: HOJE })
    expect(pago).toMatchObject({ virtual: false, custo_id: 'x', valor_previsto: 95, valor_calculado: 100, status: 'pago' })
    expect(parseIdImposto('imposto:2026-09')).toEqual({ mes: '2026-09' })
    expect(parseIdImposto('imposto:2026-13')).toBeNull()
  })

  it('calcularImpostos: recebido por data_pagamento (M-1 fechado) e projeção via receitas nos meses futuros', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('aliquota_imposto_pct')) return { rows: [{ aliquota_imposto_pct: '10.00' }] }
      if (s.includes('FROM receita_titulos') && s.includes('SUM(valor_pago)')) return { rows: [{ mes: '2026-08', total: '2000' }] }
      if (s.includes('WITH comissao_marca')) {
        // fixo 3000 vencendo em 2026-10 (competência 09 + offset 1)
        return { rows: [{ marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', competencia: '2026-09-01', comissao: 0, gmv: 0, fixo: 3000, fixo_cheio: 3000, fator_meses: 1, marca_nome: 'A', tipo_cobranca: 'fixo_mais_comissao', fixo_vencimento_dia: 5, fixo_vencimento_mes_offset: 1, comissao_vencimento_dia: 5, comissao_vencimento_mes_offset: 1 }] }
      }
      return { rows: [] }
    })
    const out = await calcularImpostos({ query }, { tenantId: TENANT, inicio: '2026-09', fim: '2026-11', hoje: HOJE })
    expect(out.map((c) => [c.mes, c.base_tipo, c.base, c.valor])).toEqual([
      ['2026-09', 'realizado', 2000, 200],
      ['2026-10', 'projetado', 0, 0],
      ['2026-11', 'projetado', 3000, 300],
    ])
    // tenant explícito em todas as queries
    for (const [sql, params] of query.mock.calls) {
      expect(String(sql)).toMatch(/tenant_id|WHERE id = \$1::uuid/)
      expect(params).toContain(TENANT)
    }
  })
})

describe('DRE', () => {
  it('por competência: receita, custos por grupo, apresentadoras, imposto e resultado', () => {
    const itens = [
      receita({ valor_pago: 1000, data_pagamento: '2026-10-05' }),
      custo(),
      custo({ id: 'c2', grupo: 'ferramentas', valor_previsto: 100, valor_pago: 100 }),
      normalizarApresentadora({ id: 'a', competencia: '2026-09-01', data_vencimento: '2026-10-10', valor_previsto: 250, valor_pago: 0 }, HOJE),
      montarItemImposto({ calculo: calcularImpostoMes({ mes: '2026-09', mesAtual: '2026-09', aliquota: 10, recebidoAnterior: 500 }), hoje: HOJE }),
      custo({ id: 'fora', competencia: '2026-10-01', valor_previsto: 999 }),
    ]
    const impostos = new Map([['2026-09', { aliquota: 10, base: 500 }]])
    const { meses, totais } = montarDre({ meses: ['2026-09'], itens, impostos, aliquota: 10 })
    expect(meses[0]).toEqual({
      mes: '2026-09',
      receita: { previsto: 1000, realizado: 1000 },
      aportes: { previsto: 0, realizado: 0 },
      custos: {
        previsto: 400, realizado: 100,
        por_grupo: { estrutural: { previsto: 300, realizado: 0 }, ferramentas: { previsto: 100, realizado: 100 } },
      },
      apresentadoras: { previsto: 250, realizado: 0 },
      imposto: { previsto: 50, realizado: 0, aliquota: 10, base: 500 },
      // v3: manuais pontuais + apresentadora sem componente (legado) + imposto = variáveis
      custos_fixos: { previsto: 0, realizado: 0 },
      custos_variaveis: { previsto: 700, realizado: 100 },
      perdas: { receita: { valor: 0 } },
      resultado: { previsto: 300, realizado: 900 },
    })
    expect(totais.resultado).toEqual({ previsto: 300, realizado: 900 })
  })
})

describe('fluxo de caixa', () => {
  it('faixas 5/10/15/20/25/30 (31 → 30) e cartão para custos do grupo cartao', () => {
    expect(['2026-09-01', '2026-09-05', '2026-09-06', '2026-09-20', '2026-09-26', '2026-10-31'].map(faixaDoDia))
      .toEqual(['5', '5', '10', '20', '30', '30'])
    expect(chaveFluxo({ natureza: 'custo', grupo: 'cartao' }, '2026-09-03')).toBe('cartao')
    expect(chaveFluxo({ natureza: 'receita', grupo: 'cartao' }, '2026-09-03')).toBe('5')
  })

  it('previsto por vencimento, realizado por pagamento, acumulado com saldo inicial e série anual', () => {
    const itens = [
      receita({ data_vencimento: '2026-09-05', valor_previsto: 1000, valor_pago: 1000, data_pagamento: '2026-09-04' }),
      custo({ data_vencimento: '2026-09-10', valor_previsto: 300 }),
      custo({ id: 'k', grupo: 'cartao', data_vencimento: '2026-09-12', valor_previsto: 200, valor_pago: 200, data_pagamento: '2026-09-12' }),
      custo({ id: 'sem', data_vencimento: null, competencia: '2026-09-01', valor_previsto: 50 }),
      receita({ id: 'out', data_vencimento: '2026-10-05', valor_previsto: 700 }),
    ]
    const f = montarFluxoCaixa({ mes: '2026-09', itens, saldoInicial: 100 })
    const linha = (k) => f.linhas.find((l) => l.chave === k)
    expect(linha('5')).toMatchObject({ entradas: { previsto: 1000, realizado: 1000 }, saidas: { previsto: 0, realizado: 0 }, acumulado: { previsto: 1100, realizado: 1100 } })
    expect(linha('10')).toMatchObject({ saidas: { previsto: 300, realizado: 0 }, acumulado: { previsto: 800, realizado: 1100 } })
    expect(linha('30').saidas.previsto).toBe(50) // sem vencimento → último dia da competência
    expect(linha('cartao')).toMatchObject({ label: 'Cartão', saidas: { previsto: 200, realizado: 200 }, acumulado: { previsto: 550, realizado: 900 } })
    expect(f.totais).toEqual({
      entradas: { previsto: 1000, realizado: 1000 },
      saidas: { previsto: 550, realizado: 200 },
      saldo: { previsto: 450, realizado: 800 },
    })
    expect(f.serie_anual).toHaveLength(12)
    expect(f.serie_anual[9]).toMatchObject({ mes: '2026-10', entradas: { previsto: 700, realizado: 0 } })
    // legado (FinanceiroPage atual)
    expect(f.items[0]).toEqual({ dia: '2026-09-05', entradas: 1000, saidas: 0 })
    expect(f.entradas).toEqual([{ dia: '2026-09-05', valor: 1000 }])
    expect(f.saidas.map((s) => s.dia)).toEqual(['2026-09-10', '2026-09-12', '2026-09-30'])
  })
})

describe('listarLancamentos (tenant explícito)', () => {
  it('une as 4 fontes, tira o imposto materializado da lista de custos e passa o tenant em toda query', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('aliquota_imposto_pct')) return { rows: [{ aliquota_imposto_pct: 10 }] }
      if (s.includes("tipo = 'imposto'")) return { rows: [{ id: 'imp1', valor: '50', valor_pago: '50', competencia: '2026-09-01', data_vencimento: '2026-09-20', data_pagamento: '2026-09-19' }] }
      if (s.includes('FROM custos') && !s.includes('custos_recorrentes')) {
        return { rows: [
          { id: 'c1', descricao: 'Aluguel', valor: '300', tipo: 'outros', grupo: 'estrutural', competencia: '2026-09-01', data_vencimento: '2026-09-10', valor_pago: null },
          { id: 'imp1', descricao: 'Imposto 09/2026', valor: '50', tipo: 'imposto', grupo: 'outros', competencia: '2026-09-01', data_vencimento: '2026-09-20', valor_pago: '50', data_pagamento: '2026-09-19' },
        ] }
      }
      return { rows: [] }
    })
    const itens = await listarLancamentos({ query }, { tenantId: TENANT, inicio: '2026-09', fim: '2026-09', hoje: HOJE })
    expect(itens.map((i) => [i.id, i.origem, i.status])).toEqual([
      ['c1', 'manual', 'atrasado'],
      ['imposto:2026-09', 'imposto', 'pago'],
    ])
    for (const [, params] of query.mock.calls) expect(params).toContain(TENANT)
  })
})

describe('rotas onda 2', () => {
  function buildApp(query = vi.fn(async () => ({ rows: [] }))) {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: TENANT, papel: 'franqueado', sub: 'u1' } })
    app.decorate('withTenant', async (_t, fn) => fn({ query }))
    app.decorate('audit', { log: async () => {} })
    return { app, query }
  }

  it('GET /lancamentos: shape {inicio,fim,hoje,itens,totais} e 400 em filtro inválido', async () => {
    const { app } = buildApp()
    await app.register(financeiroRoutes)
    const ok = await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?inicio=2026-09&fim=2026-09&natureza=custo' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ inicio: '2026-09', fim: '2026-09', itens: [], totais: { saldo_previsto: 0 } })
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?status=vencido' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?inicio=2026-09&fim=2026-01' })).statusCode).toBe(400)
    await app.close()
  })

  it('GET/PATCH /config valida alíquota e grava com tenant explícito', async () => {
    const { app, query } = buildApp(vi.fn(async () => ({ rows: [{ aliquota_imposto_pct: '6.00' }] })))
    await app.register(financeiroRoutes)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/config', payload: { aliquota_imposto_pct: 150 } })).statusCode).toBe(400)
    const res = await app.inject({ method: 'PATCH', url: '/v1/financeiro/config', payload: { aliquota_imposto_pct: 6 } })
    expect(res.json()).toEqual({ aliquota_imposto_pct: 6, data_corte: null, saldo_abertura: 0 })
    const upd = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE tenants'))
    expect(upd[1]).toEqual([TENANT, 6])
    await app.close()
  })

  it('PATCH /impostos/:mes/pagar rejeita mês inválido e imposto zerado', async () => {
    const { app } = buildApp()
    await app.register(financeiroRoutes)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/impostos/2026-13/pagar', payload: {} })).statusCode).toBe(400)
    const zero = await app.inject({ method: 'PATCH', url: '/v1/financeiro/impostos/2026-01/pagar', payload: {} })
    expect(zero.statusCode).toBe(400)
    expect(zero.json().error).toMatch(/zero/)
    const desfazer = await app.inject({ method: 'PATCH', url: '/v1/financeiro/impostos/2026-01/desfazer' })
    expect(desfazer.statusCode).toBe(404)
    await app.close()
  })

  it('/resumo usa o fixo por VIGÊNCIA e não registra mais /custos nem /franqueadora', async () => {
    const { app, query } = buildApp(vi.fn(async (sql) => ({ rows: String(sql).includes('WITH live_periodo') ? [{}] : [] })))
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-03&fim=2026-03' })
    expect(res.statusCode).toBe(200)
    const sql = String(query.mock.calls.find(([s]) => String(s).includes('WITH live_periodo'))[0])
    expect(sql).toContain('generate_series')
    expect(sql).toContain('vig.inicio')
    expect(res.json()).toMatchObject({ total_custos: 0, aliquota_imposto_pct: 10, meses: [{ mes: '2026-03' }] })
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/custos' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/franqueadora' })).statusCode).toBe(404)
    await app.close()
  })
})
