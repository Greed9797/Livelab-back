import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/financeiro-agregador.js', async (original) => {
  const actual = await original()
  return { ...actual, buscarConfigFinanceiro: vi.fn(), listarLancamentos: vi.fn(),
    hojeSaoPaulo: () => '2026-10-09', calcularFluxoCaixa: vi.fn() }
})
vi.mock('../src/services/financeiro-movimentos-periodo.js', () => ({ lerMovimentosFinanceirosPeriodo: vi.fn() }))

import { buscarConfigFinanceiro, listarLancamentos, calcularFluxoCaixa } from '../src/services/financeiro-agregador.js'
import { lerMovimentosFinanceirosPeriodo } from '../src/services/financeiro-movimentos-periodo.js'
import { montarCaixaOperacional } from '../src/services/financeiro-caixa-operacional.js'
import { selecionarObrigacoesPorVencimento } from '../src/services/financeiro-obrigacoes-vencimento.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'

const config = { data_corte: '2026-10-01', saldo_abertura: '1000.00', aliquota_imposto_pct: 0 }
const obligation = (id, value, date, overrides = {}) => ({ id, natureza: 'receita', origem: 'avulsa',
  competencia: '2026-10-01', data_vencimento: date, valor_previsto: value, valor_pago: '0.00',
  virtual: false, descricao: id, ...overrides })
const cash = (overrides = {}) => montarCaixaOperacional({ config, dataBase: '2026-10-01',
  obrigacoes: [], movimentos: [], ...overrides })
const movement = (id, value, date, overrides = {}) => ({ id, natureza: 'receita', tipo: 'liquidacao',
  origem_tipo: 'receita_avulsa', origem_id: 'receita', valor: value, data: date, fonte: 'canonico', ...overrides })

beforeEach(() => {
  vi.clearAllMocks()
  buscarConfigFinanceiro.mockImplementation(async (db) => { await db.query('SELECT config'); return config })
  listarLancamentos.mockImplementation(async (db) => { await db.query('SELECT obligations'); return [] })
  lerMovimentosFinanceirosPeriodo.mockImplementation(async (db) => {
    await db.query('SELECT movements')
    return { itens: [], reconciliacao: { eventos_canonicos: 0, movimentos_legados: 0 } }
  })
})

async function buildApp() {
  const app = Fastify()
  const query = vi.fn(async () => ({ rows: [] }))
  const withTenant = vi.fn(async (tenant, read) => read({ tenant, query }))
  const tenantParallel = vi.fn(() => { throw new Error('mixed snapshots') })
  app.decorate('withTenant', withTenant)
  app.decorate('tenantParallel', tenantParallel)
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (request.headers['x-role'] === 'anonymous') return reply.code(401).send({ error: 'unauthorized' })
    const papel = request.headers['x-role'] ?? 'financeiro_readonly'
    if (!roles.includes(papel)) return reply.code(403).send({ error: 'forbidden' })
    request.user = { tenant_id: request.headers['x-tenant'] ?? 'tenant-a', papel }
  })
  await app.register(financeiroRoutes)
  return { app, query, withTenant, tenantParallel }
}

describe('caixa operacional: projeção diária', () => {
  it('atravessa virada de ano com seis meses civis', () => {
    const result = cash({ dataBase: '2026-11-29' })
    expect(result.meses.map(m => m.mes)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'])
    expect(result.horizonte).toEqual({ inicio: '2026-11-29', fim: '2027-04-30', meses: 6 })
    expect(result.serie_diaria.at(-1).dia).toBe('2027-04-30')
  })

  it('encadeia fechamento e abertura', () => {
    const result = cash({ obrigacoes: [obligation('receber', '500.00', '2026-10-20'),
      obligation('pagar', '200.00', '2026-11-05', { natureza: 'custo', origem: 'manual' })] })
    expect(result.meses[0].saldo_final_projetado).toBe('1500.00')
    expect(result.meses[1]).toMatchObject({ saldo_inicial: '1500.00', saldo_final_projetado: '1300.00' })
    expect(result.meses[2].saldo_inicial).toBe('1300.00')
  })

  it('cartão permanece na data de vencimento', () => {
    const result = cash({ obrigacoes: [obligation('cartao', '1500.00', '2026-10-05', { natureza: 'custo', grupo: 'cartao' }),
      obligation('receita', '1000.00', '2026-10-20')] })
    expect(result.serie_diaria.find(d => d.dia === '2026-10-05')).toMatchObject({ saidas_projetadas: '1500.00', saldo_final_projetado: '-500.00' })
    expect(result.meses[0]).toMatchObject({ menor_saldo_diario: '-500.00', primeiro_dia_negativo: '2026-10-05', saldo_final_projetado: '500.00' })
  })

  it('mínimo diário antes de agrupar detecta falta dentro da mesma faixa', () => {
    const result = cash({ obrigacoes: [obligation('saida', '1500.00', '2026-10-01', { natureza: 'custo' }),
      obligation('entrada', '1000.00', '2026-10-04')] })
    expect(result.indicadores).toMatchObject({ menor_saldo_diario: '-500.00', primeiro_dia_negativo: '2026-10-01' })
    expect(result.meses[0].saldo_final_projetado).toBe('500.00')
  })

  it('movimento e corte sem duplicação: antecipação quitada, aporte igual à abertura e estorno', () => {
    const result = cash({ dataBase: '2026-10-09', movimentos: [movement('antes', '999.00', '2026-09-30'),
      movement('antecipacao', '600.00', '2026-10-01'), movement('aporte', '1000.00', '2026-10-09', { grupo: 'aporte' }),
      movement('estorno', '-100.00', '2026-10-09', { tipo: 'estorno' })],
      obrigacoes: [obligation('quitada', '600.00', '2026-11-05', { valor_pago: '600.00' })] })
    expect(result.caixa.saldo_atual).toBe('2500.00')
    expect(result.serie_diaria[0]).toMatchObject({ saldo_inicial: '1600.00', entradas_realizadas: '1000.00', saidas_realizadas: '100.00', saldo_final_projetado: '2500.00' })
    expect(result.meses[1]).toMatchObject({ entradas_projetadas: '0.00', saldo_final_projetado: '2500.00' })
  })

  it('movimento futuro só na data registrada', () => {
    const result = cash({ dataBase: '2026-10-09', movimentos: [movement('futuro', '600.00', '2026-11-05')],
      obrigacoes: [obligation('baixada', '600.00', '2026-10-20', { valor_pago: '600.00' })] })
    expect(result.caixa.saldo_atual).toBe('1000.00')
    expect(result.meses[0].saldo_final_projetado).toBe('1000.00')
    expect(result.meses[1].saldo_final_projetado).toBe('1600.00')
    expect(result.serie_diaria.find(d => d.dia === '2026-11-05')).toMatchObject({ entradas_realizadas: '0.00', entradas_projetadas: '600.00' })
    expect(result.pendencias.movimentos_futuros.map(i => i.id)).toEqual(['futuro'])
  })

  it('reserva vencido sem movimento fictício', () => {
    const result = cash({ dataBase: '2026-10-09', obrigacoes: [obligation('receber', '500.00', '2026-10-05'),
      obligation('pagar', '300.00', '2026-10-05', { natureza: 'custo', valor_pago: '100.00' })] })
    expect(result.caixa).toMatchObject({ saldo_atual: '1000.00', reserva_pagaveis_vencidos: '200.00', saldo_disponivel: '800.00' })
    expect(result.meses[0]).toMatchObject({ entradas_projetadas: '0.00', saidas_projetadas: '0.00', reserva_vencida: '200.00', saldo_final_projetado: '1000.00', saldo_disponivel_final: '800.00' })
    expect(result.movimentos).toEqual([])
    expect(result.pendencias.recebiveis_vencidos[0].saldo_aberto).toBe('500.00')
  })

  it('residual e precedência materializada preservam perda parcial, suspensão e cancelamento', async () => {
    const virtual = obligation('calc:brand:2026-10:fixo', '2000.00', '2026-10-20', { origem: 'marca_fixo', marca_id: 'brand', componente: 'fixo', virtual: true })
    const stored = { ...virtual, id: 'materializado', virtual: false, valor_previsto: '1000.00', valor_pago: '400.00', valor_perdido: '200.00' }
    listarLancamentos.mockResolvedValue([virtual, stored,
      obligation('cancelado', '200.00', '2026-10-21', { natureza: 'custo', valor_pago: '50.00', cancelado_em: '2026-10-02' }),
      obligation('suspenso', '500.00', '2026-10-22', { suspensao_comercial: { ativa: true } })])
    const obrigacoes = await selecionarObrigacoesPorVencimento({}, { tenantId: 'tenant-a', de: '2026-10-01', ate: '2027-03-31', hoje: '2026-10-09', config })
    expect(obrigacoes.filter(i => i.marca_id === 'brand').map(i => i.id)).toEqual(['materializado'])
    const result = cash({ obrigacoes })
    expect(result.meses[0]).toMatchObject({ entradas_projetadas: '400.00', saidas_projetadas: '0.00' })
    expect(result.obrigacoes.find(i => i.id === 'materializado')).toMatchObject({ valor_original: '1000.00', liquidado_acumulado: '400.00', saldo_aberto: '400.00', valor_projetado: '400.00' })
  })

  it('comissão futura não estimada e obrigação sem data ficam explícitas', () => {
    const result = cash({ obrigacoes: [obligation('comissao', '600.00', '2026-12-05', { origem: 'marca_comissao', componente: 'comissao', virtual: true, competencia: '2026-11-01' }),
      obligation('sem-data', '50.00', null)] })
    expect(result.pendencias.comissao_futura).toBe('nao_estimada')
    expect(result.pendencias.sem_data.map(i => i.id)).toEqual(['sem-data'])
    expect(result.meses[2].entradas_projetadas).toBe('0.00')
    expect(result.completude.comissoes_futuras_estimadas).toBe(false)
    expect(result.completude.obrigacoes_com_data).toBe(false)
  })

  it('reconcilia totais diários e mensais em centavos exatos', () => {
    const result = cash({ config: { ...config, saldo_abertura: '0.10' }, obrigacoes: [obligation('a', '0.10', '2026-10-02'),
      obligation('b', '0.20', '2026-10-03'), obligation('c', '0.01', '2026-10-04', { natureza: 'custo' })] })
    expect(result.meses[0]).toMatchObject({ entradas_projetadas: '0.30', saidas_projetadas: '0.01', saldo_final_projetado: '0.39' })
    for (const month of result.meses) {
      const days = result.serie_diaria.filter(d => d.dia.startsWith(month.mes))
      expect(days[0].saldo_inicial).toBe(month.saldo_inicial)
      expect(days.at(-1).saldo_final_projetado).toBe(month.saldo_final_projetado)
      expect(days.reduce((n, d) => n + Math.round(Number(d.entradas_projetadas) * 100), 0)).toBe(Math.round(Number(month.entradas_projetadas) * 100))
    }
  })

  it('não converte valor obrigatório ausente em zero', () => {
    expect(() => cash({ obrigacoes: [obligation('ausente', null, '2026-10-20')] })).toThrow(/monetário/)
  })

  it('histórico de obrigações usa lotes de até 36 meses sem corte arbitrário', async () => {
    listarLancamentos.mockResolvedValue([])
    await selecionarObrigacoesPorVencimento({}, { tenantId: 'tenant-a', de: '2026-10-01', ate: '2027-03-31',
      hoje: '2026-10-09', config, incluirVencidos: true,
      historico: { competencia_inicio: '2020-01', apresentadoras: [], pendencias: [] } })
    expect(listarLancamentos.mock.calls.map(([, opts]) => [opts.inicio, opts.fim])).toEqual([
      ['2020-01', '2022-12'], ['2023-01', '2025-12'], ['2026-01', '2027-03'],
    ])
  })

  it('início histórico desconhecido fica incompleto sem inventar dívida de apresentadora', async () => {
    const presenter = obligation('ap', '1000.00', '2020-01-10', { natureza: 'custo', origem: 'apresentadora',
      apresentadora_id: 'ap-id', componente: 'fixo', competencia: '2020-01-01', virtual: true })
    listarLancamentos.mockResolvedValue([presenter])
    const historico = { competencia_inicio: '2020-01', apresentadoras: [{ id: 'ap-id', inicio_conhecido: null }],
      pendencias: [{ origem: 'apresentadora', id: 'ap-id', motivo: 'inicio_historico_desconhecido', valor: null }] }
    const obrigacoes = await selecionarObrigacoesPorVencimento({}, { tenantId: 'tenant-a', de: '2026-10-01', ate: '2027-03-31',
      hoje: '2026-10-09', config, incluirVencidos: true, historico })
    expect(obrigacoes).toEqual([])
    const result = cash({ obrigacoes, historico })
    expect(result.completude.historico_obrigacoes_completo).toBe(false)
    expect(result.pendencias.historico).toEqual(historico.pendencias)
    expect(result.pendencias.historico[0].valor).toBeNull()
  })
})

describe('caixa operacional: rota', () => {
  it('horizonte de seis meses é fixo e data-base vem de São Paulo', async () => {
    const { app } = await buildApp()
    try {
      const response = await app.inject('/v1/financeiro/caixa-operacional')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ data_base: '2026-10-09', horizonte: { meses: 6, fim: '2027-03-31' }, caixa: { saldo_atual: '1000.00', configurado: true } })
      expect(response.json().meses).toHaveLength(6)
      expect((await app.inject('/v1/financeiro/caixa-operacional?horizonte=12')).statusCode).toBe(400)
    } finally { await app.close() }
  })

  it('não assume zero sem configuração', async () => {
    buscarConfigFinanceiro.mockResolvedValue({ data_corte: null, saldo_abertura: '0.00', aliquota_imposto_pct: 0 })
    listarLancamentos.mockResolvedValue([obligation('sem-abertura', '200.00', '2026-10-20')])
    const { app } = await buildApp()
    try {
      const response = await app.inject('/v1/financeiro/caixa-operacional')
      expect(response.statusCode).toBe(200)
      expect(response.json().caixa).toMatchObject({ configurado: false, saldo_atual: null })
      expect(response.json().meses.every(m => m.saldo_final_projetado === null)).toBe(true)
      expect(response.json().meses[0].entradas_projetadas).toBe('200.00')
      expect(lerMovimentosFinanceirosPeriodo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ de: '2026-10-09', dataCorte: null }))
    } finally { await app.close() }
  })

  it('propaga indisponibilidade sem fallback e sem cache de falha', async () => {
    buscarConfigFinanceiro.mockRejectedValue(new Error('database unavailable'))
    const { app, query } = await buildApp()
    try {
      for (let i = 0; i < 2; i++) {
        const response = await app.inject('/v1/financeiro/caixa-operacional')
        expect(response.statusCode).toBe(500)
        expect(response.json().caixa).toBeUndefined()
      }
      expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK'])
    } finally { await app.close() }
  })

  it('reconciliação obrigatória retorna 409 sem confirmar saldo', async () => {
    lerMovimentosFinanceirosPeriodo.mockRejectedValue(Object.assign(new Error('Recebimentos e pagamentos precisam de reconciliação antes de calcular o caixa.'), {
      statusCode: 409, code: 'FINANCIAL_RECONCILIATION_REQUIRED', divergencias: [{ origem_tipo: 'receita_avulsa', origem_id: 'origem', motivo: 'pagamento_sem_data' }],
    }))
    const { app, query } = await buildApp()
    try {
      const response = await app.inject('/v1/financeiro/caixa-operacional')
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ code: 'FINANCIAL_RECONCILIATION_REQUIRED' })
      expect(response.json().caixa).toBeUndefined()
      expect(query.mock.calls.at(-1)[0]).toBe('ROLLBACK')
    } finally { await app.close() }
  })

  it('é somente leitura', async () => {
    const { app, query } = await buildApp()
    try {
      expect((await app.inject('/v1/financeiro/caixa-operacional')).statusCode).toBe(200)
      expect(query.mock.calls.map(([sql]) => sql.trim()).every(sql => /^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|COMMIT)$|^(SELECT|WITH) /i.test(sql))).toBe(true)
      expect(query.mock.calls.some(([sql]) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
    } finally { await app.close() }
  })

  it('preserva autorização financeira', async () => {
    const { app, withTenant } = await buildApp()
    try {
      expect((await app.inject({ url: '/v1/financeiro/caixa-operacional', headers: { 'x-role': 'anonymous' } })).statusCode).toBe(401)
      expect((await app.inject({ url: '/v1/financeiro/caixa-operacional', headers: { 'x-role': 'apresentador' } })).statusCode).toBe(403)
      expect(withTenant).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('snapshot e cache com escopo de tenant', async () => {
    const { app, query, withTenant, tenantParallel } = await buildApp()
    try {
      const a = await app.inject('/v1/financeiro/caixa-operacional')
      const count = query.mock.calls.length
      expect((await app.inject('/v1/financeiro/caixa-operacional')).body).toBe(a.body)
      expect(query).toHaveBeenCalledTimes(count)
      await app.inject({ url: '/v1/financeiro/caixa-operacional', headers: { 'x-tenant': 'tenant-b' } })
      expect(withTenant.mock.calls.map(([tenant]) => tenant)).toEqual(['tenant-a', 'tenant-b'])
      expect(tenantParallel).not.toHaveBeenCalled()
      expect(query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      expect(query.mock.calls.at(-1)[0]).toBe('COMMIT')
      expect(listarLancamentos.mock.calls.every(([db, options]) => db.tenant === options.tenantId)).toBe(true)
    } finally { await app.close() }
  })

  it('preserva contrato legado do fluxo', async () => {
    calcularFluxoCaixa.mockResolvedValue({ linhas: [{ chave: 'cartao' }], serie_anual: [{ mes: '2026-01' }], legado: true })
    const { app } = await buildApp()
    try {
      expect((await app.inject('/v1/financeiro/fluxo-caixa?mes=2026-10')).json()).toEqual({ linhas: [{ chave: 'cartao' }], serie_anual: [{ mes: '2026-01' }], legado: true })
    } finally { await app.close() }
  })
})
