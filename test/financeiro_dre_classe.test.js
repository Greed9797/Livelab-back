// SPEC v3 (B2): classe do custo (fixo|variável), DRE com custos fixos/variáveis e
// detalhe do DRE do mês (GET /v1/financeiro/dre/mes).
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import {
  calcularImpostoMes, classeDoItem, filtrarLancamentos, montarDre, montarDreDetalhe, montarItemImposto,
  normalizarApresentadora, normalizarCusto, normalizarReceita,
} from '../src/services/financeiro-agregador.js'
import { custoParaItem, listarCustos, recorrenteParaItemVirtual } from '../src/services/custos-plano.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { financeiroCustosRoutes } from '../src/routes/financeiro_custos.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const AP1 = '33333333-3333-4333-8333-333333333333'
const AP2 = '44444444-4444-4444-8444-444444444444'
const REC = '22222222-2222-4222-8222-222222222222'
const HOJE = '2026-10-15'

const custo = (over = {}) => normalizarCusto({
  id: 'c1', origem: 'manual', descricao: 'Frete', grupo: 'operacional', tipo: 'outros',
  competencia: '2026-10-01', data_vencimento: '2026-10-10', valor_previsto: 50, valor_pago: null, data_pagamento: null,
  ...over,
}, HOJE)
const receita = (over = {}) => normalizarReceita({
  id: 'calc:m1:2026-10:fixo', componente: 'fixo', materializado: false, descricao: 'Fixo — A',
  marca_id: 'm1', marca_nome: 'Marca A', cliente_id: 'cl1', cliente_nome: 'Cliente A',
  competencia: '2026-10-01', data_vencimento: '2026-11-05', valor_previsto: 1000, valor_pago: 0, data_pagamento: null,
  ...over,
}, HOJE)
const apresentadora = (over = {}) => normalizarApresentadora({
  id: `apresentadora:${AP1}:2026-10:fixo`, apresentadora_id: AP1, componente: 'fixo',
  descricao: 'Pagamento Ana - 10/2026', competencia: '2026-10-01', data_vencimento: '2026-10-10',
  valor_previsto: 2000, valor_pago: 0, data_pagamento: null, ...over,
}, HOJE)
const imposto = (mes = '2026-10', recebido = 800) => montarItemImposto({
  calculo: calcularImpostoMes({ mes, mesAtual: '2026-10', aliquota: 10, recebidoAnterior: recebido }), hoje: HOJE,
})

describe('classeDoItem (regra única)', () => {
  it('deriva pela origem', () => {
    expect(classeDoItem({ natureza: 'custo', origem: 'manual' })).toBe('variavel')
    expect(classeDoItem({ natureza: 'custo', origem: 'recorrente' })).toBe('fixo')
    expect(classeDoItem({ natureza: 'custo', origem: 'parcela' })).toBe('fixo')
    expect(classeDoItem({ natureza: 'custo', origem: 'imposto' })).toBe('variavel')
    expect(classeDoItem({ natureza: 'custo', origem: 'apresentadora', componente: 'fixo' })).toBe('fixo')
    expect(classeDoItem({ natureza: 'custo', origem: 'apresentadora', componente: 'variavel' })).toBe('variavel')
    // contrato antigo (sem componente) → variável
    expect(classeDoItem({ natureza: 'custo', origem: 'apresentadora' })).toBe('variavel')
    expect(classeDoItem({ natureza: 'receita', origem: 'marca_fixo' })).toBeNull()
  })

  it('override classe_custo prevalece; do lançamento > do recorrente; imposto não aceita override', () => {
    expect(classeDoItem({ natureza: 'custo', origem: 'manual', classe_custo: 'fixo' })).toBe('fixo')
    expect(classeDoItem({ natureza: 'custo', origem: 'recorrente', classe_custo: 'variavel' })).toBe('variavel')
    expect(classeDoItem({ natureza: 'custo', origem: 'recorrente', classe_custo_recorrente: 'variavel' })).toBe('variavel')
    expect(classeDoItem({ natureza: 'custo', origem: 'recorrente', classe_custo: 'fixo', classe_custo_recorrente: 'variavel' })).toBe('fixo')
    expect(classeDoItem({ natureza: 'custo', origem: 'manual', classe_custo: 'xpto' })).toBe('variavel')
    expect(classeDoItem({ natureza: 'custo', origem: 'imposto', classe_custo: 'fixo' })).toBe('variavel')
  })

  it('todo item de custo sai com `classe` (custos-plano, apresentadora, imposto)', () => {
    expect(custoParaItem({ id: 'x', descricao: 'Notebook (1/3)', valor: '100', competencia: '2026-10-01', parcela_grupo_id: 'g', parcela_num: 1, parcelas_total: 3 }, HOJE))
      .toMatchObject({ origem: 'parcela', classe: 'fixo', classe_custo: null })
    expect(custoParaItem({ id: 'y', descricao: 'Brinde', valor: '10', competencia: '2026-10-01', classe_custo: 'fixo' }, HOJE))
      .toMatchObject({ origem: 'manual', classe: 'fixo', classe_custo: 'fixo' })
    expect(recorrenteParaItemVirtual({ id: REC, nome: 'Energia', grupo: 'estrutural', valor: 400, dia_vencimento: 5, classe_custo: 'variavel' }, '2026-10', HOJE))
      .toMatchObject({ virtual: true, classe: 'variavel', classe_custo: null, classe_custo_recorrente: 'variavel' })
    expect(apresentadora().classe).toBe('fixo')
    expect(apresentadora({ componente: undefined }).componente).toBeNull()
    expect(imposto().classe).toBe('variavel')
    expect(receita().classe).toBeNull()
  })

  it('listarCustos: materializado herda override do recorrente (inclusive inativo, sem N+1)', async () => {
    const rec = { id: REC, nome: 'Aluguel', grupo: 'estrutural', valor: '300', dia_vencimento: 10, mes_offset: 0, inicio: '2026-01-01', fim: null, ativo: true, classe_custo: 'variavel' }
    const inativo = '55555555-5555-4555-8555-555555555555'
    const query = vi.fn(async (sql, params) => {
      const s = String(sql)
      if (s.includes('id = ANY')) return { rows: [{ id: inativo, classe_custo: 'variavel' }] }
      if (s.includes('FROM custos_recorrentes')) return { rows: [rec] }
      if (s.includes('FROM custos')) {
        return { rows: [
          { id: 'm1', descricao: 'Aluguel', valor: '300', tipo: 'recorrente', grupo: 'estrutural', competencia: '2026-10-01', data_vencimento: '2026-10-10', recorrente_id: REC },
          { id: 'm2', descricao: 'Antigo', valor: '90', tipo: 'recorrente', grupo: 'estrutural', competencia: '2026-10-01', data_vencimento: '2026-10-10', recorrente_id: inativo },
          { id: 'm3', descricao: 'Pontual', valor: '20', tipo: 'outros', grupo: 'diversos', competencia: '2026-10-01', data_vencimento: '2026-10-10', classe_custo: 'fixo' },
        ] }
      }
      return { rows: [] }
    })
    const itens = await listarCustos({ query }, { tenantId: TENANT, inicio: '2026-10', fim: '2026-10', hoje: HOJE })
    expect(Object.fromEntries(itens.map((i) => [i.id, i.classe]))).toEqual({ m1: 'variavel', m2: 'variavel', m3: 'fixo' })
    expect(query.mock.calls.filter(([s]) => String(s).includes('id = ANY'))).toHaveLength(1)
    for (const [, params] of query.mock.calls) expect(params).toContain(TENANT)
  })

  it('filtrarLancamentos aceita classe e origem', () => {
    const itens = [custo(), custo({ id: 'r', origem: 'recorrente' }), apresentadora(), imposto(), receita()]
    expect(filtrarLancamentos(itens, { classe: 'fixo' }).map((i) => i.id)).toEqual(['r', `apresentadora:${AP1}:2026-10:fixo`])
    expect(filtrarLancamentos(itens, { classe: 'variavel', origem: 'imposto' }).map((i) => i.id)).toEqual(['imposto:2026-10'])
  })
})

// Mês 2026-10 com todas as fontes; 2026-09 só com aluguel (para delta).
function itensExemplo() {
  return [
    receita(),
    receita({ id: 'calc:m1:2026-10:comissao', componente: 'comissao', valor_previsto: 500, valor_pago: 500, data_pagamento: '2026-10-12', memoria: { gmv: 5000, comissao_bruta: 500 } }),
    receita({ id: 'calc:m2:2026-10:fixo', marca_id: 'm2', marca_nome: 'Marca B', cliente_id: 'cl2', cliente_nome: 'Cliente B', valor_previsto: 700 }),
    { natureza: 'receita', origem: 'avulsa', grupo: 'servico', id: 'av1', descricao: 'Consultoria', competencia: '2026-10-01', valor_previsto: 300, valor_pago: 300, status: 'pago' },
    { natureza: 'receita', origem: 'avulsa', grupo: 'aporte', id: 'ap1', descricao: 'Aporte sócio', competencia: '2026-10-01', valor_previsto: 1000, valor_pago: 1000, status: 'pago' },
    custo({ id: 'rec10', origem: 'recorrente', descricao: 'Aluguel', grupo: 'estrutural', valor_previsto: 300, valor_pago: 300, data_pagamento: '2026-10-10' }),
    custo({ id: 'par', origem: 'parcela', descricao: 'Notebook (1/3)', grupo: 'cartao', valor_previsto: 100 }),
    custo({ id: 'man', descricao: 'Frete', valor_previsto: 50 }),
    custo({ id: 'ovr', descricao: 'Contador', grupo: 'operacional', valor_previsto: 150, classe_custo: 'fixo' }),
    apresentadora(),
    apresentadora({ id: `apresentadora:${AP1}:2026-10:variavel`, componente: 'variavel', valor_previsto: 450, comissao: 400, adicionais: 50, data_vencimento: '2026-11-15' }),
    apresentadora({ id: `apresentadora:${AP2}:2026-10:variavel`, apresentadora_id: AP2, descricao: 'Pagamento Bia (variável) - 10/2026', componente: 'variavel', valor_previsto: 100, comissao: 100, adicionais: 0 }),
    imposto(),
    custo({ id: 'rec09', origem: 'recorrente', descricao: 'Aluguel', grupo: 'estrutural', competencia: '2026-09-01', data_vencimento: '2026-09-10', valor_previsto: 300, valor_pago: 300, data_pagamento: '2026-09-10' }),
    receita({ id: 'calc:m1:2026-09:fixo', competencia: '2026-09-01', data_vencimento: '2026-10-05', valor_previsto: 1000, valor_pago: 1000, data_pagamento: '2026-10-05' }),
  ]
}

describe('montarDre: custos fixos × variáveis', () => {
  it('imposto e apresentadora-variável em variáveis; resultado = receita − fixos − variáveis; aporte fora', () => {
    const { meses: [, out] } = montarDre({ meses: ['2026-09', '2026-10'], itens: itensExemplo(), aliquota: 10 })
    expect(out.receita).toEqual({ previsto: 2500, realizado: 800 })
    expect(out.aportes).toEqual({ previsto: 1000, realizado: 1000 })
    // fixos: aluguel 300 + parcela 100 + override 150 + Ana fixo 2000
    expect(out.custos_fixos).toEqual({ previsto: 2550, realizado: 300 })
    // variáveis: frete 50 + Ana var 450 + Bia 100 + imposto 80
    expect(out.custos_variaveis).toEqual({ previsto: 680, realizado: 0 })
    expect(out.resultado).toEqual({ previsto: -730, realizado: 500 })
    // chaves legadas preservadas e coerentes com o mesmo resultado
    expect(out.custos.previsto + out.apresentadoras.previsto + out.imposto.previsto).toBe(3230)
    expect(out.imposto).toMatchObject({ previsto: 80 })
  })
})

describe('montarDreDetalhe (GET /dre/mes)', () => {
  const d = montarDreDetalhe({ mes: '2026-10', itens: itensExemplo(), aliquota: 10 })

  it('atual, anterior e delta', () => {
    expect(d.mes).toBe('2026-10')
    expect(d.anterior).toMatchObject({ mes: '2026-09', receita: { previsto: 1000 }, custos_fixos: { previsto: 300 }, custos_variaveis: { previsto: 0 } })
    expect(d.delta).toEqual({
      receita: { previsto: 1500, realizado: -200 },
      custos_fixos: { previsto: 2250, realizado: 0 },
      custos_variaveis: { previsto: 680, realizado: 0 },
      resultado: { previsto: -1430, realizado: -200 },
      perdas: { receita: { valor: 0 } },
    })
  })

  it('receita por cliente → marca com fixo/comissão previstos × realizados, gmv e pct', () => {
    expect(d.receita.total).toEqual(d.atual.receita)
    expect(d.receita.por_cliente[0]).toEqual({
      cliente_id: 'cl1', cliente_nome: 'Cliente A', total: { previsto: 1500, realizado: 500 },
      perdido: 0,
      marcas: [{ marca_id: 'm1', marca_nome: 'Marca A', fixo: { previsto: 1000, realizado: 0 }, comissao: { previsto: 500, realizado: 500 }, gmv: 5000, pct: 10, perdido: 0 }],
    })
    expect(d.receita.por_cliente[1].marcas[0]).toMatchObject({ marca_nome: 'Marca B', comissao: { previsto: 0, realizado: 0 }, gmv: null, pct: null })
    expect(d.receita.avulsas.map((a) => a.id)).toEqual(['av1'])
    expect(d.aportes.map((a) => a.id)).toEqual(['ap1'])
  })

  it('custos fixos/variáveis por grupo + apresentadoras por pessoa + imposto; totais batem', () => {
    const soma = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100
    const cf = d.custos_fixos
    expect(cf.por_grupo.map((g) => [g.grupo, g.total.previsto])).toEqual([['estrutural', 300], ['operacional', 150], ['cartao', 100]])
    expect(cf.por_grupo[0].itens[0]).toMatchObject({ id: 'rec10', origem: 'recorrente', previsto: 300, realizado: 300, status: 'pago', data_vencimento: '2026-10-10' })
    expect(cf.apresentadoras_fixo).toEqual([{ apresentadora_id: AP1, nome: 'Ana', previsto: 2000, realizado: 0 }])
    expect(soma([...cf.por_grupo.map((g) => g.total.previsto), ...cf.apresentadoras_fixo.map((a) => a.previsto)])).toBe(cf.total.previsto)

    const cv = d.custos_variaveis
    expect(cv.por_grupo.map((g) => g.grupo)).toEqual(['operacional'])
    expect(cv.apresentadoras_variavel).toEqual([
      { apresentadora_id: AP1, nome: 'Ana', comissao: 400, adicionais: 50, previsto: 450, realizado: 0 },
      { apresentadora_id: AP2, nome: 'Bia', comissao: 100, adicionais: 0, previsto: 100, realizado: 0 },
    ])
    expect(cv.imposto).toMatchObject({ previsto: 80, realizado: 0, aliquota: 10, base: 800, base_tipo: 'realizado', mes_base: '2026-09' })
    expect(soma([...cv.por_grupo.map((g) => g.total.previsto), ...cv.apresentadoras_variavel.map((a) => a.previsto), cv.imposto.previsto]))
      .toBe(cv.total.previsto)
  })

  it('margem de contribuição = receita − variáveis', () => {
    expect(d.margem).toEqual({ contribuicao: { previsto: 1820, realizado: 800 }, pct: { previsto: 72.8, realizado: 100 } })
  })

  it('apresentadora sem componente (contrato antigo) cai em variáveis', () => {
    const legado = normalizarApresentadora({ id: `apresentadora:${AP1}:2026-10`, apresentadora_id: AP1, descricao: 'Pagamento Ana - 10/2026', competencia: '2026-10-01', valor_previsto: 2450, fixo: 2000, comissao: 400, adicionais: 50, valor_pago: 0 }, HOJE)
    const x = montarDreDetalhe({ mes: '2026-10', itens: [legado] })
    expect(x.custos_fixos.total.previsto).toBe(0)
    expect(x.custos_variaveis.apresentadoras_variavel).toEqual([{ apresentadora_id: AP1, nome: 'Ana', comissao: 400, adicionais: 50, previsto: 2450, realizado: 0 }])
    expect(x.margem.pct).toEqual({ previsto: null, realizado: null })
  })
})

describe('rotas', () => {
  function buildApp(query) {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: TENANT, papel: 'franqueado', sub: 'u1' } })
    app.decorate('withTenant', async (_t, fn) => fn({ query }))
    app.decorate('audit', { log: async () => {} })
    return app
  }

  it('GET /dre/mes: 1 leitura de custos para m−1..m, corte aplicado e tenant explícito', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('aliquota_imposto_pct')) return { rows: [{ aliquota_imposto_pct: 10, data_corte: '2026-10-01', saldo_abertura: 0 }] }
      if (s.includes('FROM custos_recorrentes')) return { rows: [] }
      if (s.includes("tipo = 'imposto'")) return { rows: [] }
      if (s.includes('FROM custos')) {
        return { rows: [
          { id: 'a', descricao: 'Aluguel set', valor: '300', tipo: 'outros', grupo: 'estrutural', competencia: '2026-09-01', data_vencimento: '2026-09-10' },
          { id: 'b', descricao: 'Frete out', valor: '50', tipo: 'outros', grupo: 'operacional', competencia: '2026-10-01', data_vencimento: '2026-10-10' },
          { id: 'c', descricao: 'Contador', valor: '150', tipo: 'outros', grupo: 'operacional', competencia: '2026-10-01', data_vencimento: '2026-10-20', classe_custo: 'fixo' },
        ] }
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(financeiroRoutes)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/dre/mes?mes=2026-13' })).statusCode).toBe(400)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/dre/mes?mes=2026-10' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ mes: '2026-10', mes_anterior: '2026-09', data_corte: '2026-10-01', aliquota: 10 })
    // custo de setembro vence antes do corte → fora (anterior zerado)
    expect(body.anterior.custos_variaveis).toEqual({ previsto: 0, realizado: 0 })
    expect(body.atual.custos_fixos).toEqual({ previsto: 150, realizado: 0 })
    expect(body.atual.custos_variaveis).toEqual({ previsto: 50, realizado: 0 })
    expect(body.custos_fixos.por_grupo[0].itens[0]).toMatchObject({ id: 'c', classe: 'fixo' })
    const leituras = query.mock.calls.filter(([s]) => /FROM custos\s+WHERE tenant_id = \$1::uuid\s+AND competencia/.test(String(s)))
    expect(leituras).toHaveLength(1)
    expect(leituras[0][1]).toEqual([TENANT, '2026-09-01', '2026-10-31'])
    for (const [, params] of query.mock.calls) expect(params).toContain(TENANT)
    await app.close()
  })

  it('GET /lancamentos aceita ?classe= e ?origem= (e valida)', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('aliquota_imposto_pct')) return { rows: [{ aliquota_imposto_pct: 10 }] }
      if (s.includes('FROM custos_recorrentes') || s.includes("tipo = 'imposto'")) return { rows: [] }
      if (s.includes('FROM custos')) {
        return { rows: [
          { id: 'b', descricao: 'Frete', valor: '50', tipo: 'outros', grupo: 'operacional', competencia: '2026-10-01', data_vencimento: '2026-10-10' },
          { id: 'p', descricao: 'Notebook (1/2)', valor: '100', tipo: 'parcela', grupo: 'cartao', competencia: '2026-10-01', data_vencimento: '2026-10-10', parcela_grupo_id: 'g', parcela_num: 1, parcelas_total: 2 },
        ] }
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(financeiroRoutes)
    const fixo = await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?mes=2026-10&classe=fixo' })
    expect(fixo.json().itens.map((i) => i.id)).toEqual(['p'])
    const manual = await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?mes=2026-10&origem=manual' })
    expect(manual.json().itens.map((i) => [i.id, i.classe])).toEqual([['b', 'variavel']])
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?classe=outra' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?origem=xpto' })).statusCode).toBe(400)
    await app.close()
  })

  it('POST/PATCH custos e custos-recorrentes aceitam classe_custo (fixo|variavel|null)', async () => {
    const query = vi.fn(async (sql, params) => ({ rows: [{ id: REC, descricao: 'X', valor: '10', competencia: '2026-10-01', classe_custo: params?.at?.(-1) ?? null }] }))
    const app = buildApp(query)
    await app.register(financeiroCustosRoutes)
    const post = await app.inject({ method: 'POST', url: '/v1/financeiro/custos', payload: { descricao: 'X', valor: 10, competencia: '2026-10', classe_custo: 'fixo' } })
    expect(post.statusCode).toBe(201)
    const ins = query.mock.calls.find(([s]) => String(s).includes('INSERT INTO custos ('))
    expect(String(ins[0])).toContain('classe_custo')
    expect(ins[1].at(-1)).toBe('fixo')
    expect(ins[1][0]).toBe(TENANT)
    expect((await app.inject({ method: 'POST', url: '/v1/financeiro/custos', payload: { descricao: 'X', valor: 10, competencia: '2026-10', classe_custo: 'outro' } })).statusCode).toBe(400)

    const patch = await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos/${REC}`, payload: { classe_custo: null } })
    expect(patch.statusCode).toBe(200)
    const upd = query.mock.calls.find(([s]) => String(s).startsWith('UPDATE custos SET'))
    expect(String(upd[0])).toContain('classe_custo = $3')
    expect(upd[1]).toEqual([REC, TENANT, null])

    const recPost = await app.inject({ method: 'POST', url: '/v1/financeiro/custos-recorrentes', payload: { nome: 'Energia', valor: 400, inicio: '2026-01-01', classe_custo: 'variavel' } })
    expect(recPost.statusCode).toBe(201)
    const recIns = query.mock.calls.find(([s]) => String(s).includes('INSERT INTO custos_recorrentes'))
    expect(recIns[1].at(-1)).toBe('variavel')
    const recPatch = await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos-recorrentes/${REC}`, payload: { classe_custo: 'fixo' } })
    expect(recPatch.statusCode).toBe(200)
    const recUpd = query.mock.calls.find(([s]) => String(s).startsWith('UPDATE custos_recorrentes'))
    expect(recUpd[1]).toEqual([REC, TENANT, 'fixo'])
    await app.close()
  })
})

describe('montarDreDetalhe — receita por cliente com marcas sem cliente (cadastro unificado F4a)', () => {
  const titulo = (marca_id, marca_nome, cliente_id, cliente_nome, valor, origem = 'marca_comissao') => ({
    natureza: 'receita', origem, competencia: '2026-10-01', data_vencimento: '2026-11-05',
    marca_id, marca_nome, cliente_id, cliente_nome, valor_previsto: valor, valor_pago: 0,
  })
  const itens = [
    titulo('m-a', 'Afiliada A', null, null, 100),
    titulo('m-b', 'Afiliada B', null, null, 50),
    titulo('m-c', 'Cliente C', 'c-1', 'Cliente C', 300, 'marca_fixo'),
  ]
  const d = montarDreDetalhe({ mes: '2026-10', itens, aliquota: 10 })

  it('cada marca sem cliente vira o próprio grupo (chave sem-cliente:<marca_id>), com o nome da marca', () => {
    const semCliente = d.receita.por_cliente.filter((c) => c.cliente_id == null)
    expect(semCliente).toHaveLength(2)
    expect(semCliente.map((c) => c.cliente_nome).sort()).toEqual(['Afiliada A', 'Afiliada B'])
    expect(semCliente.every((c) => c.marcas.length === 1)).toBe(true)
  })

  it('totais idênticos (cosmético)', () => {
    const soma = d.receita.por_cliente.reduce((s, c) => s + c.total.previsto, 0)
    expect(soma).toBe(450)
    expect(d.receita.por_cliente.find((c) => c.cliente_id === 'c-1').cliente_nome).toBe('Cliente C')
  })
})
