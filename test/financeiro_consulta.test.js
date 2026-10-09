import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/financeiro-agregador.js', async (importOriginal) => {
  const original = await importOriginal()
  return { ...original, listarLancamentos: vi.fn(), buscarConfigFinanceiro: vi.fn(async () => ({ data_corte: null, saldo_abertura: 0, aliquota_imposto_pct: 0 })) }
})
vi.mock('../src/services/financeiro-movimentos-periodo.js', () => ({ lerMovimentosFinanceirosPeriodo: vi.fn() }))

import { listarLancamentos } from '../src/services/financeiro-agregador.js'
import { financeiroConsultaRoutes } from '../src/routes/financeiro_consulta.js'
import { parseConsultaQuery } from '../src/services/financeiro-consulta.js'
import { lerMovimentosFinanceirosPeriodo } from '../src/services/financeiro-movimentos-periodo.js'

const ROOT = '/v1/financeiro/consulta?eixo=competencia&inicio=2026-09&fim=2026-09'

function item(id, overrides = {}) {
  return {
    id, natureza: 'receita', origem: 'avulsa', status: 'pendente',
    competencia: '2026-09-01', data_vencimento: '2026-09-10', data_pagamento: null,
    descricao: `Receita ${id}`, grupo: 'receita', componente: null, marca_nome: null,
    cliente_nome: null, observacao: null, valor_previsto: 0.1, valor_pago: 0,
    ...overrides,
  }
}

async function appFor(role = 'financeiro_readonly') {
  const app = Fastify()
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(role)) return reply.code(403).send({ error: 'forbidden' })
    request.user = { tenant_id: 'tenant-a', papel: role }
  })
  const queries = []
  app.decorate('withTenant', async (tenantId, fn) => fn({ tenantId, query: async (sql) => { queries.push(sql) } }))
  app.decorate('tenantParallel', () => { throw new Error('tenantParallel must not be used for snapshot reads') })
  app.testQueries = queries
  await app.register(financeiroConsultaRoutes)
  return app
}

describe('FIN-04 consulta', () => {
  it('JSON e CSV preservam reconciliação 409 e apenas divergências sanitizadas', async () => {
    listarLancamentos.mockResolvedValue([])
    const safe = { origem_tipo: 'custo', origem_id: '00000000-0000-4000-8000-000000000001', motivo: 'pagamento_sem_data' }
    lerMovimentosFinanceirosPeriodo.mockRejectedValue(Object.assign(new Error('Reconciliação necessária'), {
      statusCode: 409, code: 'FINANCIAL_RECONCILIATION_REQUIRED',
      divergencias: [{ ...safe, sql: 'private diagnostic' }, { ...safe }, { origem_tipo: 'secrets', origem_id: 'invalid', motivo: 'private diagnostic' }],
    }))
    const app = await appFor()
    app.setErrorHandler((error, _request, reply) => reply.code(error.statusCode ?? 500).send({ error: error.message }))
    try {
      for (const suffix of ['', '.csv']) {
        const response = await app.inject(`/v1/financeiro/consulta${suffix}?eixo=pagamento&inicio=2026-09&fim=2026-09&competencia_inicio=2026-09&competencia_fim=2026-09`)
        expect(response.statusCode).toBe(409)
        expect(response.headers['content-type']).toContain('application/json')
        expect(response.json()).toEqual({ error: 'Reconciliação necessária', code: 'FINANCIAL_RECONCILIATION_REQUIRED', divergencias: [safe] })
        expect(app.testQueries.at(-1)).toBe('ROLLBACK')
      }
    } finally { await app.close() }
  })

  it('totaliza o conjunto filtrado antes de paginar e ordena com desempate estável', async () => {
    listarLancamentos.mockResolvedValue([
      item('b', { valor_previsto: 0.2, valor_pago: 0.1 }),
      item('a'),
      item('fora', { competencia: '2026-08-01', valor_previsto: 999 }),
      item('c', { natureza: 'custo', valor_previsto: 50 }),
    ])
    const app = await appFor()
    const response = await app.inject({ method: 'GET', url: `${ROOT}&natureza=receita&pagina=2&limite=1` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      itens: [{ id: 'b', valor_previsto: '0.20', valor_pago: '0.10', saldo_aberto: '0.10' }], total_registros: 2,
      totais: { previsto: '0.30', pago: '0.10', aberto: '0.20' },
      pagina: 2, limite: 1, total_paginas: 2,
      filtros: { eixo: 'competencia', inicio: '2026-09', fim: '2026-09', ordenar: 'data', direcao: 'asc', natureza: 'receita' },
    })
    expect(listarLancamentos).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }), expect.objectContaining({ tenantId: 'tenant-a', inicio: '2026-09', fim: '2026-09' }))
    expect(app.testQueries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT'])
    await app.close()
  })

  it('CSV usa o mesmo recorte, ignora pagina/limite e neutraliza fórmulas em texto', async () => {
    listarLancamentos.mockResolvedValue([
      item('b', { descricao: '  =HYPERLINK("x")', observacao: '\t+cmd', valor_previsto: 1.23, valor_pago: 0.23 }),
      item('a', { descricao: '@SUM(1)', valor_previsto: 2 }),
    ])
    const app = await appFor()
    const query = `${ROOT}&status=pendente&valor_min=1.00&ordenar=valor&direcao=desc&pagina=2&limite=1`
    const json = (await app.inject({ method: 'GET', url: query })).json()
    const csv = await app.inject({ method: 'GET', url: query.replace('/consulta?', '/consulta.csv?') })
    expect(json.total_registros).toBe(2)
    expect(json.itens).toHaveLength(1)
    expect(json.totais).toEqual({ previsto: '3.23', pago: '0.23', aberto: '3.00' })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body).toContain("'@SUM(1)")
    expect(csv.body).toContain("'  =HYPERLINK")
    expect(csv.body).toContain("'\t+cmd")
    expect(csv.body).toContain('"1.23"')
    expect(csv.body).toContain('saldo_aberto')
    expect(csv.body).toContain('"1.00"')
    expect(csv.body).toContain('"consulta";"')
    expect(csv.body).toContain('eixo=competencia')
    expect(csv.body).toContain('status=pendente')
    expect(csv.body).toMatch(/"data_referencia";"\d{4}-\d{2}-\d{2}"/)
    expect(csv.body.split('\r\n')).toHaveLength(6)
    await app.close()
  })

  it('filtra pelo eixo de vencimento e aplica competência como filtro adicional', async () => {
    listarLancamentos.mockResolvedValue([
      item('yes', { competencia: '2026-08-01', data_vencimento: '2026-09-20' }),
      item('no', { competencia: '2026-08-01', data_vencimento: '2026-10-01' }),
    ])
    const app = await appFor()
    const res = await app.inject({ method: 'GET', url: `${ROOT.replace('competencia', 'vencimento')}&competencia_inicio=2026-08&competencia_fim=2026-08` })
    expect(res.json().itens.map((i) => i.id)).toEqual(['yes'])
    expect(listarLancamentos).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inicio: '2026-08', fim: '2026-09', vencimentoDe: '2026-09-01', vencimentoAte: '2026-09-30' }))
    await app.close()
  })

  it('vencimento sem competência no período inclui obrigação antiga e valida filtros opcionais', async () => {
    listarLancamentos.mockResolvedValue([
      item('antiga', { competencia: '2024-01-01', data_vencimento: '2026-09-20', valor_previsto: 100 }),
      item('fora', { competencia: '2026-09-01', data_vencimento: '2026-10-01' }),
    ])
    const app = await appFor()
    try {
      const url = ROOT.replace('competencia', 'vencimento')
      const response = await app.inject(url)
      expect(response.statusCode).toBe(200)
      expect(response.json().itens.map(i => i.id)).toEqual(['antiga'])
      expect(listarLancamentos).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ vencimentoDe: '2026-09-01', vencimentoAte: '2026-09-30', regraCorte: 'nenhum' }))
      expect((await app.inject(`${url}&competencia_inicio=2026-09&competencia_fim=2026-09`)).json().itens).toEqual([])
      expect((await app.inject(`${url}&competencia_inicio=2026-09`)).statusCode).toBe(400)
    } finally { await app.close() }
  })

  it('JSON e CSV compartilham seleção por vencimento, identidade e centavos', async () => {
    const base = { origem: 'marca_fixo', marca_id: 'marca', componente: 'fixo', competencia: '2024-01-01', data_vencimento: '2026-09-20' }
    listarLancamentos.mockResolvedValue([
      item('virtual', { ...base, virtual: true, valor_previsto: 999 }),
      item('materializado', { ...base, virtual: false, valor_previsto: 0.3, valor_pago: 0.1 }),
    ])
    const app = await appFor()
    try {
      const url = ROOT.replace('competencia', 'vencimento')
      const json = (await app.inject(`${url}&limite=1`)).json()
      const csv = await app.inject(url.replace('/consulta?', '/consulta.csv?'))
      expect(json.total_registros).toBe(1)
      expect(json.totais).toEqual({ previsto: '0.30', pago: '0.10', aberto: '0.20' })
      expect(csv.body).toContain('"materializado"')
      expect(csv.body).not.toContain('"virtual"')
      expect(csv.body).toContain('"0.30";"0.10";"0.20"')
    } finally { await app.close() }
  })

  it('separa liquidado no período do acumulado, inclusive estorno e CSV', async () => {
    listarLancamentos.mockResolvedValue([item('parcial', { competencia: '2026-09-01', valor_previsto: 1000,
      valor_pago: 1000, data_pagamento: '2026-11-05' })])
    lerMovimentosFinanceirosPeriodo.mockImplementation(async (_db, { de }) => ({
      itens: [{ id: de, origem_tipo: 'receita_avulsa', origem_id: 'parcial', natureza: 'receita',
        origem: 'avulsa', competencia: '2026-09-01', tipo: 'liquidacao', data: `${de.slice(0, 7)}-05`,
        valor: de.startsWith('2026-10') ? '400.00' : '600.00', fonte: 'canonico' }],
      reconciliacao: { eventos_canonicos: 1, movimentos_legados: 0 },
    }))
    const app = await appFor()
    try {
      const query = mes => `/v1/financeiro/consulta?eixo=pagamento&inicio=${mes}&fim=${mes}&competencia_inicio=2026-09&competencia_fim=2026-09`
      for (const [mes, expected] of [['2026-10', '400.00'], ['2026-11', '600.00']]) {
        const response = await app.inject(query(mes))
        expect(response.statusCode).toBe(200)
        expect(response.json().itens).toHaveLength(1)
        expect(response.json().itens[0]).toMatchObject({ valor_pago: '1000.00', liquidado_no_periodo: expected })
        expect(response.json().totais).toMatchObject({ pago: '1000.00', liquidado_no_periodo: expected })
        const csv = await app.inject(query(mes).replace('/consulta?', '/consulta.csv?'))
        expect(csv.body).toContain('liquidado_no_periodo')
        expect(csv.body).toContain(`"${expected}"`)
      }
      lerMovimentosFinanceirosPeriodo.mockResolvedValue({ itens: [{ id: 'refund', origem_tipo: 'receita_avulsa', origem_id: 'parcial',
        natureza: 'receita', origem: 'avulsa', competencia: '2026-09-01', tipo: 'estorno', data: '2026-12-05', valor: '-100.00', fonte: 'canonico' }],
        reconciliacao: { eventos_canonicos: 1, movimentos_legados: 0 } })
      expect((await app.inject(query('2026-12'))).json().totais.liquidado_no_periodo).toBe('-100.00')
    } finally { await app.close() }
  })

  it('aplica origem, texto, faixa numérica e direção; saldo encerrado não fica em aberto', async () => {
    listarLancamentos.mockResolvedValue([
      item('old', { origem: 'manual', descricao: 'Taxa A', valor_previsto: 2, valor_pago: 0, status: 'cancelado', natureza: 'custo', cancelado_em: '2026-09-20' }),
      item('new', { origem: 'manual', descricao: 'Taxa B', valor_previsto: 3, valor_pago: 1, natureza: 'custo' }),
      item('different', { origem: 'avulsa', descricao: 'Taxa C', valor_previsto: 2 }),
    ])
    const app = await appFor()
    const res = await app.inject({ method: 'GET', url: `${ROOT}&natureza=custo&origem=manual&q=taxa&valor_min=2&valor_max=3&ordenar=valor&direcao=desc` })
    expect(res.statusCode).toBe(200)
    expect(res.json().itens.map((i) => i.id)).toEqual(['new', 'old'])
    expect(res.json().itens.map((i) => i.saldo_aberto)).toEqual(['2.00', '0.00'])
    expect(res.json().totais).toEqual({ previsto: '5.00', pago: '1.00', aberto: '2.00' })
    await app.close()
  })

  it('expõe sobrepagamento assinado e marca a linha inconsistente', async () => {
    listarLancamentos.mockResolvedValue([
      item('overpaid', { valor_previsto: 1, valor_pago: 1.25, status: 'pago' }),
      item('open', { valor_previsto: 2, valor_pago: 0 }),
    ])
    const app = await appFor()
    const res = (await app.inject({ method: 'GET', url: ROOT })).json()
    expect(res.itens.map(({ id, saldo_aberto, inconsistente }) => ({ id, saldo_aberto, inconsistente }))).toEqual([
      { id: 'open', saldo_aberto: '2.00', inconsistente: false },
      { id: 'overpaid', saldo_aberto: '-0.25', inconsistente: true },
    ])
    expect(res.totais.aberto).toBe('1.75')
    const csv = await app.inject({ method: 'GET', url: ROOT.replace('/consulta?', '/consulta.csv?') })
    expect(csv.body).toContain('"-0.25"')
    await app.close()
  })

  it('filtra contraparte e componente no mesmo recorte do CSV', async () => {
    listarLancamentos.mockResolvedValue([
      item('fixed', { cliente_nome: 'Árvore Comércio', componente: 'fixo', valor_previsto: 10 }),
      item('variable', { cliente_nome: 'Árvore Comércio', componente: 'comissao', valor_previsto: 20 }),
      item('other', { cliente_nome: 'Outra Marca', componente: 'fixo', valor_previsto: 30 }),
    ])
    const app = await appFor()
    const filtro = `${ROOT}&contraparte=arvore&componente=fixo`
    const response = (await app.inject({ method: 'GET', url: filtro })).json()
    expect(response.itens.map((row) => row.id)).toEqual(['fixed'])
    expect(response.totais.previsto).toBe('10.00')
    const csv = await app.inject({ method: 'GET', url: filtro.replace('/consulta?', '/consulta.csv?') })
    expect(csv.body).toContain('"fixed"')
    expect(csv.body).not.toContain('"variable"')
    expect(csv.body).not.toContain('"other"')
    await app.close()
  })

  it('localiza uma obrigação por origem e ID para abrir a exceção correta', async () => {
    listarLancamentos.mockResolvedValue([
      item('same', { origem: 'avulsa', valor_previsto: 10 }),
      item('same', { origem: 'marca_fixo', valor_previsto: 20 }),
      item('other', { origem: 'avulsa', valor_previsto: 30 }),
    ])
    const app = await appFor()
    const response = (await app.inject({ method: 'GET', url: `${ROOT}&origem=avulsa&id=same` })).json()
    expect(response.itens.map((row) => [row.id, row.origem])).toEqual([['same', 'avulsa']])
    expect(response.totais.previsto).toBe('10.00')
    await app.close()
  })

  it('faz rollback se a seleção falhar', async () => {
    listarLancamentos.mockRejectedValue(new Error('read failed'))
    const app = await appFor()
    const res = await app.inject({ method: 'GET', url: ROOT })
    expect(res.statusCode).toBe(500)
    expect(app.testQueries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK'])
    await app.close()
  })

  it('não publica zero quando um valor monetário obrigatório está ausente', async () => {
    listarLancamentos.mockResolvedValue([item('missing', { valor_previsto: null })])
    const app = await appFor()
    const response = await app.inject({ method: 'GET', url: ROOT })
    expect(response.statusCode).toBe(422)
    expect(app.testQueries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK'])
    await app.close()
  })

  it('responde 400 para filtros inválidos e 403 fora do papel financeiro', async () => {
    const app = await appFor()
    for (const suffix of ['&origem=nao', '&valor_min=1.001', '&valor_min=2&valor_max=1', '&direcao=sideways', '&limite=201', '&pagina=0', '&x=1']) {
      expect((await app.inject({ method: 'GET', url: ROOT + suffix })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: ROOT.replace('/consulta?', '/consulta.csv?') + suffix })).statusCode).toBe(400)
    }
    expect((await app.inject({ method: 'GET', url: ROOT.replace('competencia', 'pagamento') })).statusCode).toBe(400)
    await app.close()
    const forbidden = await appFor('apresentador')
    expect((await forbidden.inject({ method: 'GET', url: ROOT })).statusCode).toBe(403)
    expect((await forbidden.inject({ method: 'GET', url: ROOT.replace('/consulta?', '/consulta.csv?') })).statusCode).toBe(403)
    await forbidden.close()
  })

  it('valida limite temporal e normaliza filtros para contrato estável', () => {
    expect(() => parseConsultaQuery({ eixo: 'competencia', inicio: '2026-01', fim: '2029-01' })).toThrow(/36 meses/)
    expect(parseConsultaQuery({ eixo: 'competencia', inicio: '2026-09', fim: '2026-09' })).toMatchObject({
      pagina: 1, limite: 50, filtros: { competencia_inicio: '2026-09', competencia_fim: '2026-09', origem: null, q: null },
    })
  })
})
