import { describe, expect, it } from 'vitest'

import {
  addMeses,
  bucketVencimento,
  calcularDRE,
  calcularDREPeriodo,
  calcularFluxoMes,
  calcularSerieAnual,
  contratoVigenteNoMes,
  fixoContratosPorPeriodo,
  mesesEntre,
  montarItensMes,
  planejarGeracaoCustos,
  planejarGeracaoReceitas,
  receitasCalculadasMes,
  resolverPeriodo,
  statusReceita,
  vencimentoNoMes,
} from '../src/services/financeiro_calc.js'

const contrato = (over = {}) => ({
  id: 'c1', cliente_id: 'cli1', status: 'ativo', valor_fixo: 1000,
  dia_vencimento: 10, ativado_em: '2026-01-15', fim_em: null, ...over,
})

describe('datas', () => {
  it('addMeses cruza a virada de ano', () => {
    expect(addMeses('2026-01', -1)).toBe('2025-12')
    expect(addMeses('2025-12', 1)).toBe('2026-01')
    expect(addMeses('2026-03', 14)).toBe('2027-05')
  })

  it('mesesEntre é inclusivo', () => {
    expect(mesesEntre('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('vencimentoNoMes limita ao último dia e trata null como fim do mês', () => {
    expect(vencimentoNoMes('2026-02', 30)).toBe('2026-02-28')
    expect(vencimentoNoMes('2026-04', null)).toBe('2026-04-30')
    expect(vencimentoNoMes('2026-04', 5)).toBe('2026-04-05')
  })

  it('resolverPeriodo aceita inicio/fim, mes=YYYY-MM, mes+ano e fallback', () => {
    expect(resolverPeriodo({ inicio: '2026-01', fim: '2026-03' })).toEqual({ inicio: '2026-01', fim: '2026-03' })
    expect(resolverPeriodo({ mes: '2026-05' })).toEqual({ inicio: '2026-05', fim: '2026-05' })
    expect(resolverPeriodo({ mes: '4', ano: '2026' })).toEqual({ inicio: '2026-04', fim: '2026-04' })
    expect(resolverPeriodo({}, '2026-09-30')).toEqual({ inicio: '2026-09', fim: '2026-09' })
    expect(resolverPeriodo({ inicio: '2026-05', fim: '2026-01' }).error).toBeTruthy()
    expect(resolverPeriodo({ inicio: '2026-13', fim: '2026-14' }).error).toBeTruthy()
  })

  it('bucketVencimento arredonda para a próxima linha do fluxo', () => {
    expect(bucketVencimento(1)).toBe('5')
    expect(bucketVencimento(5)).toBe('5')
    expect(bucketVencimento(6)).toBe('10')
    expect(bucketVencimento(25)).toBe('25')
    expect(bucketVencimento(31)).toBe('30')
    expect(bucketVencimento(null)).toBe('30')
    expect(bucketVencimento(10, true)).toBe('cartao')
  })
})

describe('contratos por período', () => {
  it('contrato iniciado no meio do mês conta o mês inteiro, mas não os anteriores', () => {
    const c = contrato({ ativado_em: '2026-03-20' })
    expect(contratoVigenteNoMes(c, '2026-02')).toBe(false)
    expect(contratoVigenteNoMes(c, '2026-03')).toBe(true)
    expect(contratoVigenteNoMes(c, '2026-04')).toBe(true)
  })

  it('contrato encerrado no meio do mês conta até esse mês', () => {
    const c = contrato({ status: 'cancelado', ativado_em: '2026-01-10', fim_em: '2026-03-12' })
    expect(contratoVigenteNoMes(c, '2026-03')).toBe(true)
    expect(contratoVigenteNoMes(c, '2026-04')).toBe(false)
  })

  it('contrato reativado ignora cancelado_em antigo', () => {
    const c = contrato({ status: 'ativo', ativado_em: '2026-05-01', fim_em: '2026-02-01' })
    expect(contratoVigenteNoMes(c, '2026-06')).toBe(true)
  })

  it('contrato não-ativo sem data de término é ignorado', () => {
    const c = contrato({ status: 'arquivado', fim_em: null })
    expect(contratoVigenteNoMes(c, '2026-02')).toBe(false)
  })

  it('range multi-mês soma mês a mês (não multiplica contratos de hoje)', () => {
    const contratos = [
      contrato({ id: 'a', valor_fixo: 1000, ativado_em: '2025-12-01' }),                                 // jan..mar
      contrato({ id: 'b', valor_fixo: 500, ativado_em: '2026-02-15' }),                                  // fev..mar
      contrato({ id: 'c', valor_fixo: 300, status: 'cancelado', ativado_em: '2025-06-01', fim_em: '2026-01-20' }), // só jan
    ]
    const r = fixoContratosPorPeriodo(contratos, mesesEntre('2026-01', '2026-03'))
    expect(r.porMes).toEqual({ '2026-01': 1300, '2026-02': 1500, '2026-03': 1500 })
    expect(r.total).toBe(4300)
    // A fórmula antiga (ativos hoje × 3 meses) daria (1000+500) × 3 = 4500
    expect(r.total).not.toBe(4500)
  })
})

describe('receitas previstas', () => {
  const vendas = [
    { cliente_id: 'cli1', mes: '2026-02', comissao_franquia: 250, gmv: 10000, comissao_apresentadora: 150 },
    { cliente_id: 'cli2', mes: '2026-02', comissao_franquia: 80, gmv: 4000, comissao_apresentadora: 40 },
  ]

  it('comissão de M vem do GMV de M-1', () => {
    const r = receitasCalculadasMes('2026-03', [contrato()], vendas)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ contrato_id: 'c1', fixo_previsto: 1000, comissao_prevista: 250, gmv_base: 10000, dia_vencimento: 10 })
  })

  it('contrato encerrado em M-1 ainda cobra a comissão em M, sem fixo', () => {
    const c = contrato({ status: 'cancelado', fim_em: '2026-02-20' })
    const r = receitasCalculadasMes('2026-03', [c], vendas)
    expect(r).toEqual([expect.objectContaining({ fixo_previsto: 0, comissao_prevista: 250 })])
  })

  it('contrato iniciado em M não herda comissão de GMV anterior ao contrato', () => {
    const c = contrato({ ativado_em: '2026-03-05' })
    const r = receitasCalculadasMes('2026-03', [c], vendas)
    expect(r[0]).toMatchObject({ fixo_previsto: 1000, comissao_prevista: 0 })
  })

  it('comissão do cliente vai para um único contrato (o mais recente)', () => {
    const antigo = contrato({ id: 'c-old', ativado_em: '2025-01-01' })
    const novo = contrato({ id: 'c-new', ativado_em: '2026-01-01' })
    const r = receitasCalculadasMes('2026-03', [antigo, novo], vendas)
    const soma = r.reduce((s, x) => s + x.comissao_prevista, 0)
    expect(soma).toBe(250)
    expect(r.find((x) => x.contrato_id === 'c-new').comissao_prevista).toBe(250)
  })

  it('geração é idempotente: 2ª rodada não insere nem atualiza', () => {
    const contratos = [contrato(), contrato({ id: 'c2', cliente_id: 'cli2', valor_fixo: 700, dia_vencimento: 5 })]
    const p1 = planejarGeracaoReceitas({ mes: '2026-03', contratos, vendas, existentes: [] })
    expect(p1.inserir).toHaveLength(2)
    expect(p1.atualizar).toHaveLength(0)

    // Simula o que ficou gravado
    const gravadas = p1.inserir.map((r, i) => ({
      id: `rp${i}`, ...r, fixo_recebido: 0, comissao_recebida: 0, status: 'previsto', ajuste_manual: false,
    }))
    const p2 = planejarGeracaoReceitas({ mes: '2026-03', contratos, vendas, existentes: gravadas })
    expect(p2.inserir).toHaveLength(0)
    expect(p2.atualizar).toHaveLength(0)
    expect(p2.inalteradas).toHaveLength(2)
  })

  it('geração atualiza linha intocada mas preserva ajuste manual e recebimentos', () => {
    const contratos = [contrato({ valor_fixo: 1200 })]
    const base = { contrato_id: 'c1', fixo_previsto: 1000, comissao_prevista: 250, gmv_base: 10000, dia_vencimento: 10,
      fixo_recebido: 0, comissao_recebida: 0, status: 'previsto', ajuste_manual: false }
    expect(planejarGeracaoReceitas({ mes: '2026-03', contratos, vendas, existentes: [{ id: 'x', ...base }] }).atualizar)
      .toEqual([expect.objectContaining({ id: 'x', fixo_previsto: 1200 })])
    expect(planejarGeracaoReceitas({ mes: '2026-03', contratos, vendas, existentes: [{ id: 'x', ...base, ajuste_manual: true }] }).atualizar)
      .toHaveLength(0)
    expect(planejarGeracaoReceitas({ mes: '2026-03', contratos, vendas, existentes: [{ id: 'x', ...base, fixo_recebido: 1000, status: 'parcial' }] }).atualizar)
      .toHaveLength(0)
  })

  it('statusReceita: previsto, parcial, recebido e atrasado', () => {
    const r = { competencia: '2026-03-01', dia_vencimento: 10, fixo_previsto: 1000, comissao_prevista: 200, fixo_recebido: 0, comissao_recebida: 0 }
    expect(statusReceita(r, '2026-03-05')).toBe('previsto')
    expect(statusReceita({ ...r, fixo_recebido: 1000 }, '2026-03-05')).toBe('parcial')
    expect(statusReceita({ ...r, fixo_recebido: 1000 }, '2026-03-11')).toBe('atrasado')
    expect(statusReceita({ ...r, fixo_recebido: 1000, comissao_recebida: 200 }, '2026-04-01')).toBe('recebido')
  })
})

describe('custos recorrentes', () => {
  const recorrentes = [
    { id: 'r1', nome: 'Aluguel', grupo: 'estrutural', valor: 3000, dia_vencimento: 10, inicio: '2026-01-01', fim: null, ativo: true },
    { id: 'r2', nome: 'Parcela PC', grupo: 'investimento', valor: 500, dia_vencimento: null, cartao: true, inicio: '2026-01-01', fim: '2026-02-28', ativo: true },
    { id: 'r3', nome: 'Inativo', grupo: 'diversos', valor: 10, inicio: '2026-01-01', fim: null, ativo: false },
  ]

  it('gera só os vigentes no mês', () => {
    expect(planejarGeracaoCustos({ mes: '2026-02', recorrentes }).inserir.map((c) => c.recorrente_id)).toEqual(['r1', 'r2'])
    expect(planejarGeracaoCustos({ mes: '2026-03', recorrentes }).inserir.map((c) => c.recorrente_id)).toEqual(['r1'])
  })

  it('geração é idempotente por (recorrente_id, competência)', () => {
    const p1 = planejarGeracaoCustos({ mes: '2026-02', recorrentes })
    expect(p1.inserir[0]).toMatchObject({ competencia: '2026-02-01', valor: 3000, grupo: 'estrutural' })
    const p2 = planejarGeracaoCustos({ mes: '2026-02', recorrentes, existentes: p1.inserir })
    expect(p2.inserir).toHaveLength(0)
    // lançamento de outro mês não conta
    const p3 = planejarGeracaoCustos({ mes: '2026-03', recorrentes, existentes: p1.inserir })
    expect(p3.inserir).toHaveLength(1)
  })
})

describe('DRE e fluxo de caixa', () => {
  const dados = {
    aliquota: 6,
    contratos: [contrato({ valor_fixo: 2000, dia_vencimento: 5 })],
    vendas: [{ cliente_id: 'cli1', mes: '2026-02', comissao_franquia: 1000, gmv: 50000, comissao_apresentadora: 600 }],
    receitas: [],
    custos: [
      { id: 'k1', grupo: 'estrutural', tipo: 'aluguel', valor: 1500, competencia: '2026-03-01', status: 'pago', dia_vencimento: 10 },
      { id: 'k2', grupo: 'aporte', tipo: 'aporte', valor: 5000, competencia: '2026-03-01', status: 'pago', dia_vencimento: 1 },
      { id: 'k3', grupo: 'variavel_produtos', tipo: 'produtos', valor: 200, competencia: '2026-03-01', status: 'previsto', cartao: true },
    ],
    recorrentes: [
      { id: 'r1', nome: 'Internet', grupo: 'estrutural', valor: 100, dia_vencimento: 15, inicio: '2026-01-01', fim: null, ativo: true },
    ],
  }

  it('DRE previsto x realizado com imposto, aportes e comissão de apresentadora', () => {
    const { previsto, realizado } = calcularDRE(montarItensMes(dados, '2026-03'))
    expect(previsto.receita).toEqual({ fixo: 2000, comissao: 1000, total: 3000 })
    expect(previsto.aportes).toBe(5000)
    expect(previsto.custos_fixos.total).toBe(1600)                    // aluguel + internet (recorrente virtual)
    expect(previsto.custos_variaveis.por_grupo).toEqual({ variavel_produtos: 200, variavel_comissao: 600 })
    expect(previsto.imposto).toBe(180)                                // 6% de 3000
    expect(previsto.resultado).toBe(3000 + 5000 - 1600 - 800 - 180)

    expect(realizado.receita.total).toBe(0)
    expect(realizado.aportes).toBe(5000)
    expect(realizado.custos_fixos.total).toBe(1500)
    expect(realizado.imposto).toBe(0)
  })

  it('receita lançada substitui a calculada e recorrente materializado não duplica', () => {
    const d = {
      ...dados,
      receitas: [{ id: 'rp1', contrato_id: 'c1', competencia: '2026-03-01', fixo_previsto: 2000, comissao_prevista: 900,
        fixo_recebido: 2000, comissao_recebida: 0, dia_vencimento: 5 }],
      custos: [...dados.custos, { id: 'k4', grupo: 'estrutural', valor: 100, competencia: '2026-03-01', status: 'previsto', recorrente_id: 'r1', dia_vencimento: 15 }],
    }
    const { previsto, realizado } = calcularDRE(montarItensMes(d, '2026-03'))
    expect(previsto.receita).toEqual({ fixo: 2000, comissao: 900, total: 2900 })
    expect(realizado.receita.total).toBe(2000)
    expect(realizado.imposto).toBe(120)
    expect(previsto.custos_fixos.total).toBe(1600)
  })

  it('DRE de período soma mês a mês', () => {
    const r = calcularDREPeriodo(dados, ['2026-02', '2026-03'])
    expect(r.meses.map((m) => m.previsto.receita.fixo)).toEqual([2000, 2000])
    expect(r.total.previsto.receita.fixo).toBe(4000)
    // comissão de fev depende do GMV de jan (inexistente)
    expect(r.meses[0].previsto.receita.comissao).toBe(0)
  })

  it('fluxo do mês: linhas por vencimento com acumulado', () => {
    const linhas = calcularFluxoMes(montarItensMes(dados, '2026-03'), { previsto: 100, realizado: 0 })
    expect(linhas.map((l) => l.dia)).toEqual(['5', '10', '15', '20', '25', '30', 'cartao'])
    const l5 = linhas.find((l) => l.dia === '5')
    // dia 5: receita 3000 + aporte (dia 1) 5000 - comissão apresentadoras 600
    expect(l5).toMatchObject({ entradas_previstas: 8000, saidas_previstas: 600, saldo_previsto: 7400, acumulado_previsto: 7500 })
    expect(linhas.find((l) => l.dia === '10').acumulado_previsto).toBe(6000)
    expect(linhas.find((l) => l.dia === '15').acumulado_previsto).toBe(5900)
    expect(linhas.find((l) => l.dia === '20').saidas_previstas).toBe(180) // imposto
    const ultima = linhas.at(-1)
    expect(ultima).toMatchObject({ dia: 'cartao', saidas_previstas: 200 })
    expect(ultima.acumulado_previsto).toBe(100 + 3000 + 5000 - 1600 - 800 - 180)
    expect(ultima.acumulado_realizado).toBe(5000 - 1500)
  })

  it('série anual acumula saldo entre meses', () => {
    const serie = calcularSerieAnual(dados, ['2026-01', '2026-02', '2026-03'], { previsto: 1000, realizado: 0 })
    // jan e fev: fixo 2000 - internet 100 - imposto 120 = 1780
    expect(serie[0]).toMatchObject({ saldo_inicial_previsto: 1000, saldo_previsto: 1780, acumulado_previsto: 2780 })
    expect(serie[1]).toMatchObject({ saldo_inicial_previsto: 2780, acumulado_previsto: 4560 })
    expect(serie[2].saldo_inicial_previsto).toBe(4560)
    expect(serie[2].acumulado_previsto).toBe(4560 + serie[2].saldo_previsto)
  })
})
