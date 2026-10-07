// SPEC perdas (B2): receita PERDIDA e custo CANCELADO na agregação do financeiro —
// totais de lançamentos, DRE (anual e /dre/mes), caixa, fluxo, projeção do imposto,
// conciliação Asaas e total de custos da home. Lógica pura + banco mockado.
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/receitas-comercial.js', async (orig) => {
  const real = await orig()
  return { ...real, receberTitulo: vi.fn() }
})
vi.mock('../src/services/receitas-avulsas.js', async (orig) => {
  const real = await orig()
  return { ...real, receberReceitaAvulsa: vi.fn() }
})

import * as receitas from '../src/services/receitas-comercial.js'
import * as avulsasMod from '../src/services/receitas-avulsas.js'
import {
  abertosAte, encerrado, filtrarLancamentos, montarDre, montarDreDetalhe, montarFluxoCaixa, normalizarCusto,
  normalizarReceita, previstoEfetivo, previstoReceitaPorVencimento, totalizarLancamentos, valorEncerrado,
} from '../src/services/financeiro-agregador.js'
import { candidatoDeLancamento, darBaixaConciliacao, sugerirMatches } from '../src/services/conciliacao.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const T_ID = '22222222-2222-4222-8222-222222222222'
const C_ID = '33333333-3333-4333-8333-333333333333'
const HOJE = '2026-10-15'
const PERDIDO_EM = '2026-10-12T13:00:00.000Z'

const receita = (over = {}) => normalizarReceita({
  id: 'r1', componente: 'fixo', materializado: true, descricao: 'Fixo — A',
  marca_id: 'm1', marca_nome: 'Marca A', cliente_id: 'cl1', cliente_nome: 'Cliente A',
  competencia: '2026-10-01', data_vencimento: '2026-10-05', valor_previsto: 1000, valor_pago: 0, data_pagamento: null,
  ...over,
}, HOJE)
const custo = (over = {}) => normalizarCusto({
  id: 'c1', origem: 'manual', descricao: 'Internet', grupo: 'ferramentas', tipo: 'outros',
  competencia: '2026-10-01', data_vencimento: '2026-10-10', valor_previsto: 300, valor_pago: null, data_pagamento: null,
  ...over,
}, HOJE)

// Cenário: fixo 1000 perdido PARCIAL (pagou 400) + comissão 500 normal em aberto (atrasada) +
// avulsa 200 perdida sem pagamento; custo 300 cancelado, recorrente 150 cancelado no mês,
// custo 100 normal em aberto.
const cenario = () => [
  receita({ valor_pago: 400, data_pagamento: '2026-10-06', perdido_em: PERDIDO_EM, perdido_motivo: 'Cliente quebrou' }),
  receita({ id: 'r2', componente: 'comissao', descricao: 'Comissão — A', valor_previsto: 500 }),
  {
    id: 'av1', natureza: 'receita', origem: 'avulsa', grupo: 'servico', descricao: 'Consultoria',
    competencia: '2026-10-01', data_vencimento: '2026-10-08', valor_previsto: 200, valor_pago: 0,
    status: 'perdido', perdido_em: PERDIDO_EM, perdido_motivo: null,
  },
  custo({ cancelado_em: PERDIDO_EM, cancelado_motivo: 'Duplicado' }),
  custo({ id: 'rc1', origem: 'recorrente', descricao: 'Aluguel', grupo: 'estrutural', tipo: 'recorrente', valor_previsto: 150, cancelado_em: PERDIDO_EM, cancelado_motivo: 'Perdoado' }),
  custo({ id: 'c2', descricao: 'Frete', grupo: 'operacional', data_vencimento: '2026-10-20', valor_previsto: 100 }),
]

describe('helpers de encerramento', () => {
  it('status perdido/cancelado (derivado OU pelo campo) e saldo encerrado = previsto − pago', () => {
    const [perdida, normal, avulsa, cancelado] = cenario()
    expect(perdida).toMatchObject({ status: 'perdido', perdido_motivo: 'Cliente quebrou', cancelado_em: null })
    expect(encerrado(perdida)).toBe(true)
    expect(valorEncerrado(perdida)).toBe(600)
    expect(previstoEfetivo(perdida)).toBe(400)
    expect(encerrado(normal)).toBe(false)
    expect(normal).toMatchObject({ perdido_em: null, perdido_motivo: null, cancelado_em: null, cancelado_motivo: null })
    expect(valorEncerrado(avulsa)).toBe(200)
    expect(cancelado).toMatchObject({ status: 'cancelado', cancelado_motivo: 'Duplicado' })
    expect(previstoEfetivo(cancelado)).toBe(0)
    // pago tem precedência: quitado nunca é encerrado
    expect(encerrado({ valor_previsto: 100, valor_pago: 100, perdido_em: PERDIDO_EM })).toBe(false)
  })
})

describe('GET /lancamentos: totais e filtro', () => {
  it('receita.perdido / custo.cancelado; fora de pendente/atrasado; saldo_previsto desconta', () => {
    const t = totalizarLancamentos(cenario())
    expect(t.receita).toEqual({ previsto: 1700, pago: 400, atrasado: 500, pendente: 0, perdido: 800 })
    expect(t.custo).toEqual({ previsto: 550, pago: 0, atrasado: 0, pendente: 100, cancelado: 450 })
    expect(t.saldo_previsto).toBe((1700 - 800) - (550 - 450))
    expect(t.saldo_realizado).toBe(400)
  })

  it('?status=perdido|cancelado filtra pelo status derivado', () => {
    const itens = cenario()
    expect(filtrarLancamentos(itens, { status: 'perdido' }).map((i) => i.id)).toEqual(['r1', 'av1'])
    expect(filtrarLancamentos(itens, { status: 'cancelado' }).map((i) => i.id)).toEqual(['c1', 'rc1'])
  })

  it('rota aceita status=perdido e status=cancelado', async () => {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: TENANT, papel: 'franqueado', sub: 'u1' } })
    app.decorate('withTenant', async (_t, fn) => fn({ query: vi.fn(async () => ({ rows: [] })) }))
    app.decorate('audit', { log: async () => {} })
    await app.register(financeiroRoutes)
    for (const st of ['perdido', 'cancelado']) {
      const res = await app.inject({ method: 'GET', url: `/v1/financeiro/lancamentos?inicio=2026-10&fim=2026-10&status=${st}` })
      expect(res.statusCode).toBe(200)
      expect(res.json().totais).toMatchObject({ receita: { perdido: 0 }, custo: { cancelado: 0 } })
    }
    await app.close()
  })
})

describe('DRE com perdas', () => {
  it('receita.previsto inalterado; perdas.receita; custos sem cancelados; resultado.previsto desconta; realizado inalterado', () => {
    const itens = cenario()
    const { meses: [out], totais } = montarDre({ meses: ['2026-10'], itens, aliquota: 10 })
    expect(out.receita).toEqual({ previsto: 1700, realizado: 400 })
    expect(out.perdas).toEqual({ receita: { valor: 800 } })
    expect(out.custos).toEqual({ previsto: 100, realizado: 0, por_grupo: {
      ferramentas: { previsto: 0, realizado: 0 }, estrutural: { previsto: 0, realizado: 0 }, operacional: { previsto: 100, realizado: 0 },
    } })
    expect(out.custos_fixos.previsto + out.custos_variaveis.previsto).toBe(100)
    expect(out.resultado).toEqual({ previsto: 1700 - 800 - 100, realizado: 400 })
    expect(totais.perdas).toEqual({ receita: { valor: 800 } })
    expect(totais.resultado).toEqual(out.resultado)
  })

  it('sem perdas, resultado é o de sempre (perdas 0)', () => {
    const { meses: [out] } = montarDre({ meses: ['2026-10'], itens: [receita(), custo()], aliquota: 10 })
    expect(out.perdas.receita.valor).toBe(0)
    expect(out.resultado.previsto).toBe(700)
  })

  it('/dre/mes: itens perdidos/cancelados no detalhe com status, motivo e saldo; invariantes', () => {
    const itens = [
      ...cenario(),
      receita({ id: 'r9', competencia: '2026-09-01', data_vencimento: '2026-09-05', valor_previsto: 1000, perdido_em: PERDIDO_EM }),
    ]
    const d = montarDreDetalhe({ mes: '2026-10', itens, aliquota: 10, hoje: HOJE })
    expect(d.atual.perdas.receita.valor).toBe(800)
    expect(d.anterior.perdas.receita.valor).toBe(1000)
    expect(d.delta.perdas).toEqual({ receita: { valor: -200 } })
    expect(d.receita.total).toEqual(d.atual.receita)
    expect(d.receita.perdas).toEqual({ valor: 800 })
    expect(d.receita.perdidos.map((p) => [p.id, p.status, p.valor_encerrado, p.perdido_motivo])).toEqual([
      ['r1', 'perdido', 600, 'Cliente quebrou'],
      ['av1', 'perdido', 200, null],
    ])
    expect(d.receita.por_cliente[0]).toMatchObject({ total: { previsto: 1500, realizado: 400 }, perdido: 600, marcas: [{ perdido: 600 }] })
    expect(d.receita.avulsas[0]).toMatchObject({ id: 'av1', status: 'perdido', previsto: 200, valor_encerrado: 200 })
    const todosCustos = [...d.custos_fixos.por_grupo, ...d.custos_variaveis.por_grupo].flatMap((g) => g.itens)
    expect(todosCustos.find((i) => i.id === 'c1')).toMatchObject({
      status: 'cancelado', cancelado_motivo: 'Duplicado', previsto: 0, valor_previsto: 300, valor_encerrado: 300,
    })
    expect(todosCustos.find((i) => i.id === 'rc1')).toMatchObject({ status: 'cancelado', cancelado_motivo: 'Perdoado', previsto: 0 })
    // Σ itens por grupo = total do grupo (cancelado conta 0)
    for (const g of [...d.custos_fixos.por_grupo, ...d.custos_variaveis.por_grupo]) {
      expect(g.itens.reduce((s, i) => s + i.previsto, 0)).toBe(g.total.previsto)
    }
    const a = d.atual
    expect(a.resultado.previsto).toBe(Math.round((a.receita.previsto - a.perdas.receita.valor
      - a.custos_fixos.previsto - a.custos_variaveis.previsto) * 100) / 100)
  })
})

describe('caixa e fluxo', () => {
  it('abertosAte: a_receber sem perdidos, a_pagar sem cancelados', () => {
    expect(abertosAte(cenario(), { dataCorte: '2026-10-01', fimMes: '2026-10-31' })).toEqual({ a_receber: 500, a_pagar: 100 })
  })

  it('fluxo: previsto de entradas sem perdidos, saídas sem cancelados; realizado inalterado', () => {
    const f = montarFluxoCaixa({ mes: '2026-10', itens: cenario(), movimentos: [{ natureza: 'receita', data: '2026-10-05', valor: 400 }], saldoInicial: 0 })
    // entradas previstas: r1 conta só o pago (400) + comissão 500; avulsa perdida 0
    expect(f.totais.entradas).toEqual({ previsto: 900, realizado: 400 })
    expect(f.totais.saidas).toEqual({ previsto: 100, realizado: 0 })
    expect(f.serie_anual[9].entradas.previsto).toBe(900)
    expect(f.entradas.find((d) => d.dia === '2026-10-08')).toBeUndefined() // avulsa perdida some do diário
  })
})

describe('imposto: projeção sem perdidos', () => {
  it('previstoReceitaPorVencimento ignora o saldo perdido (pagamento parcial continua)', () => {
    const brutos = [
      { data_vencimento: '2026-10-05', valor_previsto: 1000, valor_pago: 400, perdido_em: PERDIDO_EM },
      { data_vencimento: '2026-10-05', valor_previsto: 500, valor_pago: 0 },
      { data_vencimento: '2026-10-08', valor_previsto: 200, valor_pago: 0, status: 'perdido' },
    ]
    expect(previstoReceitaPorVencimento(brutos).get('2026-10')).toBe(900)
  })
})

describe('conciliação', () => {
  beforeEach(() => vi.clearAllMocks())

  it('perdido/cancelado não viram candidatos', () => {
    const [perdida, normal, avulsa, cancelado] = cenario()
    expect(candidatoDeLancamento(perdida)).toBeNull()
    expect(candidatoDeLancamento(avulsa)).toBeNull()
    expect(candidatoDeLancamento(cancelado)).toBeNull()
    expect(candidatoDeLancamento({ ...normal, status: undefined, perdido_em: PERDIDO_EM })).toBeNull()
    expect(candidatoDeLancamento(normal)).toMatchObject({ id: 'r2', valores: [500] })
    const cands = cenario().map((l) => candidatoDeLancamento(l)).filter(Boolean)
    const [s] = sugerirMatches([{ id: 'tx', tipo: 'entrada', valor: 600, data: '2026-10-12' }], cands)
    expect(s.sugestoes).toEqual([])
  })

  const fakeDb = (row) => ({ query: vi.fn(async (sql) => (/FROM (receita_titulos|receitas_avulsas|custos)/.test(String(sql)) ? { rows: [row] } : { rows: [] })) })

  it('baixa em título perdido → 409 (não chama receberTitulo)', async () => {
    const db = fakeDb({ id: T_ID, valor_pago: '400', perdido_em: PERDIDO_EM })
    await expect(darBaixaConciliacao(db, { tenantId: TENANT, transacao: { id: T_ID, valor: 600, data: '2026-10-12' }, tipo: 'receita', alvoId: T_ID }))
      .rejects.toMatchObject({ status: 409, codigo: 'ALVO_PERDIDO', message: 'Desfaça a perda/cancelamento antes' })
    expect(receitas.receberTitulo).not.toHaveBeenCalled()
  })

  it('baixa em título virtual cuja linha materializada está perdida → 409', async () => {
    const db = fakeDb({ id: T_ID, valor_pago: null, perdido_em: PERDIDO_EM })
    await expect(darBaixaConciliacao(db, {
      tenantId: TENANT, transacao: { id: T_ID, valor: 1000, data: '2026-10-12' }, tipo: 'receita', alvoId: `calc:${C_ID}:2026-10:fixo`,
    })).rejects.toMatchObject({ status: 409 })
  })

  it('baixa em avulsa perdida e em custo cancelado → 409 (sem UPDATE)', async () => {
    const dbAv = fakeDb({ id: T_ID, valor_pago: null, perdido_em: PERDIDO_EM })
    await expect(darBaixaConciliacao(dbAv, { tenantId: TENANT, transacao: { id: T_ID, valor: 200, data: '2026-10-12' }, tipo: 'avulsa', alvoId: T_ID }))
      .rejects.toMatchObject({ status: 409 })
    expect(avulsasMod.receberReceitaAvulsa).not.toHaveBeenCalled()
    const dbC = fakeDb({ id: C_ID, valor_pago: null, tipo: 'outros', cancelado_em: PERDIDO_EM })
    await expect(darBaixaConciliacao(dbC, { tenantId: TENANT, transacao: { id: T_ID, valor: 300, data: '2026-10-12' }, tipo: 'custo', alvoId: C_ID }))
      .rejects.toMatchObject({ status: 409, codigo: 'ALVO_CANCELADO' })
    expect(dbC.query.mock.calls.some(([sql]) => /UPDATE custos/.test(String(sql)))).toBe(false)
  })
})
