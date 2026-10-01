import { describe, it, expect } from 'vitest'

import {
  candidatoDeLancamento,
  darBaixaConciliacao,
  dataNoMes,
  diffMeses,
  normalizarTransacaoAsaas,
  pontuarMatch,
  resolverPeriodo,
  somarDias,
  sugerirMatches,
  validarTipoConciliacao,
} from '../src/services/conciliacao.js'

describe('helpers de data', () => {
  it('dataNoMes limita ao último dia do mês', () => {
    expect(dataNoMes('2026-02-01', 30)).toBe('2026-02-28')
    expect(dataNoMes('2024-02', 30)).toBe('2024-02-29')
    expect(dataNoMes('2026-03-01', 5)).toBe('2026-03-05')
    expect(dataNoMes('2026-03-01', null)).toBe('2026-03-01')
  })

  it('diffMeses cruza virada de ano', () => {
    expect(diffMeses('2025-12-31', '2026-01-01')).toBe(1)
    expect(diffMeses('2026-05-10', '2026-05-30')).toBe(0)
  })

  it('somarDias', () => {
    expect(somarDias('2026-03-05', -10)).toBe('2026-02-23')
    expect(somarDias('2025-12-31', 1)).toBe('2026-01-01')
  })

  it('resolverPeriodo: padrão = 1º dia do mês anterior até hoje', () => {
    expect(resolverPeriodo({}, '2026-01-15')).toEqual({ inicio: '2025-12-01', fim: '2026-01-15' })
    expect(resolverPeriodo({ inicio: '2026-03-01', fim: '2026-03-31' }, '2026-09-30'))
      .toEqual({ inicio: '2026-03-01', fim: '2026-03-31' })
  })

  it('resolverPeriodo: rejeita formato, ordem e período longo', () => {
    expect(resolverPeriodo({ inicio: '2026-3-1' }, '2026-09-30').erro).toBeTruthy()
    expect(resolverPeriodo({ inicio: '2026-02-30', fim: '2026-03-01' }, '2026-09-30').erro).toBeTruthy()
    expect(resolverPeriodo({ inicio: '2026-05-01', fim: '2026-04-01' }, '2026-09-30').erro).toMatch(/menor/)
    expect(resolverPeriodo({ inicio: '2024-01-01', fim: '2026-01-01' }, '2026-09-30').erro).toMatch(/máximo/)
  })
})

describe('normalizarTransacaoAsaas', () => {
  it('crédito vira entrada e herda customer do payment', () => {
    const t = normalizarTransacaoAsaas(
      { id: 'ft_1', value: 1498.01, type: 'PAYMENT_RECEIVED', date: '2026-03-05', paymentId: 'pay_1', description: 'Cobrança' },
      { id: 'pay_1', customer: 'cus_A', value: 1500 },
    )
    expect(t).toMatchObject({
      asaas_id: 'ft_1', tipo: 'entrada', valor: 1498.01, valor_bruto: 1500,
      data: '2026-03-05', payment_id: 'pay_1', customer_id: 'cus_A', tipo_asaas: 'PAYMENT_RECEIVED',
    })
    expect(t.raw.pagamento.id).toBe('pay_1')
  })

  it('débito vira saída com valor absoluto', () => {
    const t = normalizarTransacaoAsaas({ id: 'ft_2', value: -1.99, type: 'PAYMENT_FEE', date: '2026-03-05' })
    expect(t).toMatchObject({ tipo: 'saida', valor: 1.99, customer_id: null, valor_bruto: null })
  })

  it('descarta itens inválidos', () => {
    expect(normalizarTransacaoAsaas(null)).toBeNull()
    expect(normalizarTransacaoAsaas({ id: 'x', value: 'abc', date: '2026-01-01' })).toBeNull()
    expect(normalizarTransacaoAsaas({ id: 'x', value: 1, date: 'ontem' })).toBeNull()
  })
})

describe('validarTipoConciliacao', () => {
  it('receita só com entrada, custo só com saída', () => {
    expect(validarTipoConciliacao('entrada', 'receita')).toBeNull()
    expect(validarTipoConciliacao('saida', 'custo')).toBeNull()
    expect(validarTipoConciliacao('saida', 'receita')).toBeTruthy()
    expect(validarTipoConciliacao('entrada', 'custo')).toBeTruthy()
    expect(validarTipoConciliacao('entrada', 'outro')).toBeTruthy()
  })
})

describe('candidatoDeLancamento', () => {
  it('receita: valor = saldo pendente, data = vencimento, customer via cliente_id', () => {
    const c = candidatoDeLancamento(
      { id: 'r1', natureza: 'receita', descricao: 'Marca X', competencia: '2026-03-01', data_vencimento: '2026-04-05',
        valor_previsto: 3450.5, valor_pago: 450.5, cliente_id: 'cl1' },
      new Map([['cl1', 'cus_A']]),
    )
    expect(c).toMatchObject({ tipo: 'receita', id: 'r1', valores: [3000], data_referencia: '2026-04-05', gateway_customer_id: 'cus_A' })
  })

  it('sem vencimento cai na competência; quitado/sem saldo vira null', () => {
    expect(candidatoDeLancamento({ id: 'c1', natureza: 'custo', valor_previsto: 120, competencia: '2026-03-01' }))
      .toMatchObject({ tipo: 'custo', valores: [120], data_referencia: '2026-03-01', gateway_customer_id: null })
    expect(candidatoDeLancamento({ id: 'x', natureza: 'custo', valor_previsto: 50, valor_pago: 50 })).toBeNull()
  })
})

describe('darBaixaConciliacao (validação)', () => {
  it('rejeita transação sem valor/data', async () => {
    await expect(darBaixaConciliacao({}, {})).rejects.toMatchObject({ status: 400 })
  })
})

describe('validarTipoConciliacao (apresentadora/imposto)', () => {
  it('apresentadora e imposto só com saída', () => {
    expect(validarTipoConciliacao('saida', 'apresentadora')).toBeNull()
    expect(validarTipoConciliacao('saida', 'imposto')).toBeNull()
    expect(validarTipoConciliacao('entrada', 'apresentadora')).toBeTruthy()
    expect(validarTipoConciliacao('entrada', 'imposto')).toBeTruthy()
  })
  it('avulsa só com entrada; custo/apresentadora/imposto não aceitam entrada', () => {
    expect(validarTipoConciliacao('entrada', 'avulsa')).toBeNull()
    expect(validarTipoConciliacao('saida', 'avulsa')).toBeTruthy()
    expect(validarTipoConciliacao('entrada', 'custo')).toBeTruthy()
  })
  it('entrada sugere receita avulsa; saída sugere apresentadora por componente', () => {
    const avulsa = candidatoDeLancamento({ id: 'av1', natureza: 'receita', origem: 'avulsa', valor_previsto: 500, valor_pago: 0, data_vencimento: '2026-03-10' })
    expect(avulsa).toMatchObject({ tipo: 'avulsa', id: 'av1', valores: [500] })
    const fixo = candidatoDeLancamento({ id: 'apresentadora:u:2026-03:fixo', natureza: 'custo', origem: 'apresentadora', valor_previsto: 2700, valor_pago: 0, data_vencimento: '2026-03-10' })
    const vari = candidatoDeLancamento({ id: 'apresentadora:u:2026-03:variavel', natureza: 'custo', origem: 'apresentadora', valor_previsto: 200, valor_pago: 0, data_vencimento: '2026-04-15' })
    const [ent] = sugerirMatches([{ id: 't1', tipo: 'entrada', valor: 500, data: '2026-03-10' }], [avulsa, fixo, vari])
    expect(ent.sugestoes.map((x) => [x.tipo, x.id])).toEqual([['avulsa', 'av1']])
    const [sai] = sugerirMatches([{ id: 't2', tipo: 'saida', valor: 200, data: '2026-04-15' }], [avulsa, fixo, vari])
    expect(sai.sugestoes[0]).toMatchObject({ tipo: 'apresentadora', id: 'apresentadora:u:2026-03:variavel' })
    expect(sai.sugestoes.some((x) => x.tipo === 'avulsa')).toBe(false)
  })
  it('candidatoDeLancamento distingue apresentadora e imposto', () => {
    const base = { natureza: 'custo', valor_previsto: 100, valor_pago: 0, data_vencimento: '2026-03-10' }
    expect(candidatoDeLancamento({ ...base, id: 'a', origem: 'apresentadora' }).tipo).toBe('apresentadora')
    expect(candidatoDeLancamento({ ...base, id: 'i', origem: 'imposto' }).tipo).toBe('imposto')
    expect(candidatoDeLancamento({ ...base, id: 'c', origem: 'manual' }).tipo).toBe('custo')
  })
})

describe('pontuarMatch / sugerirMatches', () => {
  const entrada = {
    id: 't1', tipo: 'entrada', valor: 3000, valor_bruto: null, data: '2026-03-10', customer_id: 'cus_A',
  }
  const receitaA = { tipo: 'receita', id: 'rA', valores: [3000], data_referencia: '2026-03-10', gateway_customer_id: 'cus_A' }
  const receitaB = { tipo: 'receita', id: 'rB', valores: [3000], data_referencia: '2026-03-10', gateway_customer_id: 'cus_B' }
  const receitaSemCustomer = { tipo: 'receita', id: 'rC', valores: [3000], data_referencia: '2026-04-05' }

  it('customer + valor exato + mesmo mês = 100', () => {
    const r = pontuarMatch(entrada, receitaA)
    expect(r.score).toBe(100)
    expect(r.motivos).toEqual(['mesmo_customer', 'valor_exato', 'mesmo_mes'])
    expect(r.valor_casado).toBe(3000)
  })

  it('customer divergente derruba o score', () => {
    expect(pontuarMatch(entrada, receitaB).score).toBeLessThan(40)
  })

  it('valor líquido x bruto: usa o melhor dos dois', () => {
    const t = { ...entrada, valor: 2998.01, valor_bruto: 3000 }
    expect(pontuarMatch(t, receitaA).motivos).toContain('valor_exato')
    const t2 = { ...entrada, valor: 2990, valor_bruto: null }
    expect(pontuarMatch(t2, receitaA).motivos).toContain('valor_aprox_1pct')
  })

  it('mês vizinho pontua menos que mesmo mês', () => {
    const r = pontuarMatch({ ...entrada, customer_id: null }, receitaSemCustomer)
    expect(r.motivos).toEqual(['valor_exato', 'mes_vizinho'])
    expect(r.score).toBe(40)
  })

  it('ordena, filtra por score mínimo e ignora tipo incompatível', () => {
    const custo = { tipo: 'custo', id: 'c1', valores: [3000], data_referencia: '2026-03-10' }
    const [s] = sugerirMatches([entrada], [receitaB, custo, receitaSemCustomer, receitaA])
    expect(s.transacao_id).toBe('t1')
    expect(s.sugestoes.map((x) => x.id)).toEqual(['rA', 'rC'])
    expect(s.ambiguo).toBe(false)
  })

  it('marca ambiguo quando as duas melhores empatam', () => {
    const t = { ...entrada, customer_id: null }
    const r1 = { tipo: 'receita', id: 'r1', valores: [3000], data_referencia: '2026-03-05' }
    const r2 = { tipo: 'receita', id: 'r2', valores: [3000], data_referencia: '2026-03-20' }
    const [s] = sugerirMatches([t], [r2, r1])
    expect(s.ambiguo).toBe(true)
    // desempate pela data mais próxima (10/03 → 05/03 está a 5 dias; 20/03 a 10)
    expect(s.sugestoes[0].id).toBe('r1')
  })

  it('respeita limite', () => {
    const cands = Array.from({ length: 6 }, (_, i) => ({ ...receitaA, id: `r${i}` }))
    expect(sugerirMatches([entrada], cands, { limite: 2 })[0].sugestoes).toHaveLength(2)
  })

  it('saída casa com custo', () => {
    const saida = { id: 't2', tipo: 'saida', valor: 120, data: '2026-03-01' }
    const [s] = sugerirMatches([saida], [
      candidatoDeLancamento({ id: 'c1', natureza: 'custo', valor_previsto: 120, data_vencimento: '2026-03-01' }),
      receitaA,
    ])
    expect(s.sugestoes).toHaveLength(1)
    expect(s.sugestoes[0]).toMatchObject({ tipo: 'custo', id: 'c1', score: 50 })
  })
})
