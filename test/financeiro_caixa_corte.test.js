// Corte (início do financeiro), saldo de caixa e receitas avulsas — lógica pura + rotas com db mockado.
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import {
  abertosAte, aplicarCorte, atualizarConfigFinanceiro, buscarConfigFinanceiro, calcularCaixa, calcularImpostos,
  dataEfetiva, dataValida, dentroDoCorte, diaAnterior, listarLancamentos, montarCaixa, montarDre, totalizarLancamentos,
} from '../src/services/financeiro-agregador.js'
import {
  criarReceitaAvulsa, desfazerReceitaAvulsa, editarReceitaAvulsa, excluirReceitaAvulsa, listarReceitasAvulsas,
  receberReceitaAvulsa, receitaAvulsaParaItem,
} from '../src/services/receitas-avulsas.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { financeiroReceitasAvulsasRoutes } from '../src/routes/financeiro_receitas_avulsas.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ID = '22222222-2222-4222-8222-222222222222'
const CORTE = '2026-10-01'
const HOJE = '2026-10-01'

describe('regra de corte (dentroDoCorte)', () => {
  const item = (o) => ({ natureza: 'custo', valor_previsto: 100, valor_pago: 0, data_pagamento: null, ...o })

  it('pago ANTES do corte sai (mesmo com vencimento depois)', () => {
    const i = item({ data_vencimento: '2026-10-10', valor_pago: 100, data_pagamento: '2026-09-28' })
    expect(dataEfetiva(i)).toBe('2026-09-28')
    expect(dentroDoCorte(i, CORTE)).toBe(false)
  })
  it('pago DEPOIS do corte entra (mesmo vencido antes do corte)', () => {
    const i = item({ data_vencimento: '2026-09-05', valor_pago: 100, data_pagamento: '2026-10-02' })
    expect(dataEfetiva(i)).toBe('2026-10-02')
    expect(dentroDoCorte(i, CORTE)).toBe(true)
  })
  it('vencido antes do corte e sem baixa sai', () => {
    expect(dentroDoCorte(item({ data_vencimento: '2026-09-30' }), CORTE)).toBe(false)
  })
  it('vence no dia do corte ou depois entra', () => {
    expect(dentroDoCorte(item({ data_vencimento: '2026-10-01' }), CORTE)).toBe(true)
    expect(dentroDoCorte(item({ data_vencimento: '2026-11-05' }), CORTE)).toBe(true)
  })
  it('sem vencimento usa o último dia da competência', () => {
    expect(dataEfetiva(item({ data_vencimento: null, competencia: '2026-09-01' }))).toBe('2026-09-30')
    expect(dentroDoCorte(item({ data_vencimento: null, competencia: '2026-09-01' }), CORTE)).toBe(false)
  })
  it('sem corte nada muda', () => {
    const itens = [item({ data_vencimento: '2020-01-01' }), item({ data_vencimento: '2026-10-05' })]
    expect(dentroDoCorte(itens[0], null)).toBe(true)
    expect(aplicarCorte(itens, null)).toBe(itens)
    expect(aplicarCorte(itens, CORTE)).toHaveLength(1)
  })
  it('helpers de data', () => {
    expect(dataValida('2026-02-29')).toBe(false)
    expect(dataValida('2028-02-29')).toBe(true)
    expect(dataValida('2026-10-01')).toBe(true)
    expect(diaAnterior('2026-10-01')).toBe('2026-09-30')
    expect(diaAnterior('2026-01-01')).toBe('2025-12-31')
  })
})

describe('caixa (lógica pura)', () => {
  const realizado = { receitas: 800, avulsas: 100, aportes: 5000, custos: 300, apresentadoras: 200, imposto: 0, entradas: 5900, saidas: 500 }

  it('saldo_atual = abertura + entradas − saídas; projetado soma a receber − a pagar', () => {
    const c = montarCaixa({
      config: { data_corte: CORTE, saldo_abertura: 10000 }, ate: '2026-10-15', fimMes: '2026-10-31',
      realizado, realizadoPosAte: { entradas: 0, saidas: 50 }, abertos: { a_receber: 1500, a_pagar: 700 },
    })
    expect(c).toMatchObject({
      configurado: true, data_corte: CORTE, saldo_abertura: 10000, entradas_realizadas: 5900, saidas_realizadas: 500,
      saldo_atual: 15400, a_receber: 1500, a_pagar: 700, saldo_projetado_fim_mes: 16150,
      detalhe: { entradas: { receitas: 800, avulsas: 100, aportes: 5000 }, saidas: { custos: 300, apresentadoras: 200, imposto: 0 } },
    })
  })

  it('não configurado → configurado:false e zeros', () => {
    const c = montarCaixa({ config: { data_corte: null, saldo_abertura: 999 }, ate: HOJE, fimMes: '2026-10-31' })
    expect(c).toMatchObject({
      configurado: false, data_corte: null, saldo_abertura: 0, entradas_realizadas: 0, saidas_realizadas: 0,
      saldo_atual: 0, a_receber: 0, a_pagar: 0, saldo_projetado_fim_mes: 0,
    })
  })

  it('abertosAte: só vencimento em [corte, fim do mês] e só o em aberto', () => {
    const itens = [
      { natureza: 'receita', valor_previsto: 1000, valor_pago: 400, data_vencimento: '2026-10-05' },
      { natureza: 'receita', valor_previsto: 500, valor_pago: 0, data_vencimento: '2026-11-05' }, // depois do mês
      { natureza: 'receita', valor_previsto: 300, valor_pago: 0, data_vencimento: '2026-09-25' }, // antes do corte
      { natureza: 'custo', valor_previsto: 200, valor_pago: 200, data_vencimento: '2026-10-10' }, // pago
      { natureza: 'custo', valor_previsto: 150, valor_pago: 0, data_vencimento: '2026-10-31' },
    ]
    expect(abertosAte(itens, { dataCorte: CORTE, fimMes: '2026-10-31' })).toEqual({ a_receber: 600, a_pagar: 150 })
  })
})

describe('aporte: fora da receita operacional', () => {
  const av = (o) => receitaAvulsaParaItem({
    id: ID, descricao: 'x', grupo: 'servico', valor_previsto: '100', valor_pago: '0',
    data_vencimento: '2026-10-10', data_pagamento: null, competencia: '2026-10-01', ...o,
  }, HOJE)

  it('item avulso: natureza receita, origem avulsa, status derivado', () => {
    expect(av()).toMatchObject({ natureza: 'receita', origem: 'avulsa', grupo: 'servico', status: 'pendente', aporte: false })
    expect(av({ valor_pago: '100', data_pagamento: '2026-10-01' }).status).toBe('pago')
    expect(av({ valor_pago: '40', data_pagamento: '2026-10-01' }).status).toBe('parcial')
    expect(av({ data_vencimento: '2026-09-30' }).status).toBe('atrasado')
    expect(av({ data_vencimento: '2026-11-10' }).status).toBe('previsto')
  })

  it('DRE: aporte vai para a linha aportes, fora da receita e do resultado', () => {
    const itens = [
      av({ grupo: 'aporte', valor_previsto: '5000', valor_pago: '5000', data_pagamento: '2026-10-01' }),
      av({ valor_previsto: '300' }),
    ]
    const { meses } = montarDre({ meses: ['2026-10'], itens, aliquota: 10 })
    expect(meses[0].receita).toEqual({ previsto: 300, realizado: 0 })
    expect(meses[0].aportes).toEqual({ previsto: 5000, realizado: 5000 })
    expect(meses[0].resultado).toEqual({ previsto: 300, realizado: 0 })
    expect(totalizarLancamentos(itens).aportes).toEqual({ previsto: 5000, pago: 5000 })
  })
})

// db mock: responde por trecho de SQL e registra as chamadas.
function mockDb(handlers = {}) {
  const query = vi.fn(async (sql, params) => {
    const s = String(sql)
    for (const [trecho, fn] of Object.entries(handlers)) if (s.includes(trecho)) return fn(s, params)
    return { rows: [] }
  })
  return { query }
}

describe('imposto com corte', () => {
  it('base filtra recebimentos >= data_corte e exclui aporte; outubro (M-1 fechado antes do corte) sai 0', async () => {
    const db = mockDb({
      'financeiro_data_corte': () => ({ rows: [{ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: '0' }] }),
      'FROM receita_titulos': (s, p) => {
        // o corte vai como parâmetro do SQL; o banco filtraria tudo de setembro
        expect(s).toContain('data_pagamento >= $4::date')
        expect(s).toContain("grupo <> 'aporte'")
        expect(p[3]).toBe(CORTE)
        return { rows: [] }
      },
    })
    const [out] = await calcularImpostos(db, { tenantId: TENANT, inicio: '2026-10', fim: '2026-10', hoje: HOJE })
    expect(out).toMatchObject({ mes: '2026-10', base: 0, valor: 0, base_tipo: 'realizado' })
  })

  it('projeção (M-1 corrente) inclui avulsas não-aporte com vencimento >= corte', async () => {
    const db = mockDb({
      'financeiro_data_corte': () => ({ rows: [{ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: '0' }] }),
      'FROM receitas_avulsas\n      WHERE': () => ({ rows: [
        { id: ID, descricao: 's', grupo: 'servico', valor_previsto: '1000', valor_pago: '0', data_vencimento: '2026-10-15', data_pagamento: null, competencia: '2026-10-01' },
        { id: ID, descricao: 'a', grupo: 'aporte', valor_previsto: '9000', valor_pago: '0', data_vencimento: '2026-10-15', data_pagamento: null, competencia: '2026-10-01' },
      ] }),
    })
    const [nov] = await calcularImpostos(db, { tenantId: TENANT, inicio: '2026-11', fim: '2026-11', hoje: HOJE })
    expect(nov).toMatchObject({ mes: '2026-11', base_tipo: 'projetado', base: 1000, valor: 100 })
  })
})

describe('listarLancamentos com corte e avulsas (tenant explícito)', () => {
  it('aplica o corte em todas as fontes e inclui avulsas; tenant em toda query', async () => {
    const db = mockDb({
      'financeiro_data_corte': () => ({ rows: [{ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: '1000' }] }),
      'FROM receitas_avulsas\n      WHERE': () => ({ rows: [
        { id: ID, descricao: 'Aporte sócio', grupo: 'aporte', valor_previsto: '5000', valor_pago: '5000', data_vencimento: '2026-10-01', data_pagamento: '2026-10-01', competencia: '2026-10-01' },
        { id: 'x', descricao: 'Antigo', grupo: 'servico', valor_previsto: '100', valor_pago: '0', data_vencimento: '2026-09-20', data_pagamento: null, competencia: '2026-09-01' },
      ] }),
      'FROM custos\n        WHERE': () => ({ rows: [
        { id: 'c-old', descricao: 'Vencido setembro', valor: '300', tipo: 'outros', grupo: 'estrutural', competencia: '2026-09-01', data_vencimento: '2026-09-10', valor_pago: '0' },
        { id: 'c-pago-antes', descricao: 'Pago antes', valor: '50', tipo: 'outros', grupo: 'estrutural', competencia: '2026-10-01', data_vencimento: '2026-10-10', valor_pago: '50', data_pagamento: '2026-09-29' },
        { id: 'c-ok', descricao: 'Luz', valor: '120', tipo: 'outros', grupo: 'estrutural', competencia: '2026-10-01', data_vencimento: '2026-10-10', valor_pago: '0' },
      ] }),
    })
    const itens = await listarLancamentos(db, { tenantId: TENANT, inicio: '2026-09', fim: '2026-10', hoje: HOJE })
    expect(itens.map((i) => [i.id, i.origem])).toEqual([[ID, 'avulsa'], ['c-ok', 'manual']])
    for (const [, params] of db.query.mock.calls) expect(params).toContain(TENANT)
  })
})

describe('config e caixa (banco mockado)', () => {
  it('buscar/atualizar config: subconjunto, tenant explícito', async () => {
    const db = mockDb({ 'SELECT aliquota_imposto_pct': () => ({ rows: [{ aliquota_imposto_pct: '10.00', data_corte: CORTE, saldo_abertura: '12345.67' }] }) })
    expect(await buscarConfigFinanceiro(db, TENANT)).toEqual({ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: 12345.67 })
    await atualizarConfigFinanceiro(db, TENANT, { data_corte: CORTE, saldo_abertura: 12345.67 })
    const upd = db.query.mock.calls.find(([s]) => String(s).startsWith('UPDATE tenants'))
    expect(upd[0]).toContain('financeiro_data_corte = $2::date')
    expect(upd[0]).toContain('financeiro_saldo_abertura = $3')
    expect(upd[0]).not.toContain('aliquota_imposto_pct')
    expect(upd[1]).toEqual([TENANT, CORTE, 12345.67])
    await expect(atualizarConfigFinanceiro(db, TENANT, { data_corte: '2026-02-30' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('calcularCaixa sem corte → configurado:false e não consulta lançamentos', async () => {
    const db = mockDb({ 'SELECT aliquota_imposto_pct': () => ({ rows: [{ aliquota_imposto_pct: 10, data_corte: null, saldo_abertura: 0 }] }) })
    const c = await calcularCaixa(db, { tenantId: TENANT, hoje: HOJE })
    expect(c).toMatchObject({ configurado: false, saldo_atual: 0, ate: HOJE, fim_mes: '2026-10-31' })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('calcularCaixa com corte: abertura + realizado; tenant em toda query', async () => {
    const db = mockDb({
      'SELECT aliquota_imposto_pct': () => ({ rows: [{ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: '10000' }] }),
      'FROM apresentadora_pagamentos\n         WHERE tenant_id = $1::uuid AND valor_pago > 0': (_s, p) => ({ rows: [
        p[1] === CORTE ? { receitas: '0', avulsas: '200', aportes: '5000', custos: '300', imposto: '0', apresentadoras: '0' } : {},
      ] }),
    })
    const c = await calcularCaixa(db, { tenantId: TENANT, ate: '2026-10-01', hoje: HOJE })
    expect(c).toMatchObject({ configurado: true, saldo_abertura: 10000, entradas_realizadas: 5200, saidas_realizadas: 300, saldo_atual: 14900 })
    for (const [, params] of db.query.mock.calls) expect(params).toContain(TENANT)
  })
})

describe('receitas avulsas — service (tenant explícito)', () => {
  const row = { id: ID, descricao: 'Consultoria', grupo: 'servico', valor_previsto: '500', valor_pago: '0', data_vencimento: '2026-10-20', data_pagamento: null, competencia: '2026-10-01', observacao: null }

  it('criar: competência = mês do vencimento; baixa na criação usa hoje', async () => {
    const db = mockDb({ 'INSERT INTO receitas_avulsas': () => ({ rows: [{ ...row, valor_pago: '500', data_pagamento: HOJE }] }) })
    const item = await criarReceitaAvulsa(db, { tenantId: TENANT, dados: { descricao: 'Consultoria', grupo: 'servico', valor_previsto: 500, data_vencimento: '2026-10-20', valor_pago: 500 }, hoje: HOJE })
    expect(item).toMatchObject({ status: 'pago', origem: 'avulsa' })
    const [, p] = db.query.mock.calls[0]
    expect(p[0]).toBe(TENANT)
    expect(p.slice(1)).toEqual(['Consultoria', 'servico', 500, 500, '2026-10-20', HOJE, '2026-10-01', null, null])
    await expect(criarReceitaAvulsa(db, { tenantId: TENANT, dados: { descricao: 'x', grupo: 'xpto', valor_previsto: 1, data_vencimento: '2026-10-01' } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(criarReceitaAvulsa(db, { tenantId: TENANT, dados: { descricao: 'x', valor_previsto: 0, data_vencimento: '2026-10-01' } })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('listar/editar/excluir/receber/desfazer levam tenant_id explícito', async () => {
    const db = mockDb({
      'SELECT id, descricao': () => ({ rows: [row] }),
      UPDATE: () => ({ rows: [row] }),
      DELETE: () => ({ rows: [{ id: ID }], rowCount: 1 }),
    })
    expect(await listarReceitasAvulsas(db, { tenantId: TENANT, inicio: '2026-10', fim: '2026-10', hoje: HOJE })).toHaveLength(1)
    expect(await listarReceitasAvulsas(db, { tenantId: TENANT, inicio: '2026-10', fim: '2026-10', hoje: HOJE, grupo: 'aporte' })).toHaveLength(0)
    await editarReceitaAvulsa(db, { tenantId: TENANT, id: ID, dados: { valor_previsto: 600, competencia: '2026-11-15' }, hoje: HOJE })
    await receberReceitaAvulsa(db, { tenantId: TENANT, id: ID, hoje: HOJE })
    await desfazerReceitaAvulsa(db, { tenantId: TENANT, id: ID, hoje: HOJE })
    expect(await excluirReceitaAvulsa(db, { tenantId: TENANT, id: ID })).toBe(true)
    for (const [sql, params] of db.query.mock.calls) {
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/.test(String(sql))) continue
      expect(String(sql)).toMatch(/tenant_id = \$\d::uuid/)
      expect(params).toContain(TENANT)
    }
    const edit = db.query.mock.calls.find(([s]) => String(s).includes('UPDATE') && String(s).includes('competencia ='))
    expect(edit[1]).toEqual([ID, TENANT, 600, '2026-11-01'])
    expect(await editarReceitaAvulsa(db, { tenantId: TENANT, id: 'nao-uuid', dados: { descricao: 'x' } })).toBeNull()
  })
})

describe('rotas', () => {
  function buildApp(db = mockDb()) {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: TENANT, papel: 'franqueado', sub: null } })
    app.decorate('withTenant', async (_t, fn) => fn(db))
    app.decorate('audit', { log: async () => {} })
    return app
  }

  it('PATCH /config aceita subconjunto e valida data/saldo', async () => {
    const db = mockDb({ 'SELECT aliquota_imposto_pct': () => ({ rows: [{ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: '-250.5' }] }) })
    const app = buildApp(db)
    await app.register(financeiroRoutes)
    const ok = await app.inject({ method: 'PATCH', url: '/v1/financeiro/config', payload: { data_corte: CORTE, saldo_abertura: -250.5 } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: -250.5 })
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/config', payload: { data_corte: null } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/config', payload: { data_corte: '01/10/2026' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/config', payload: { saldo_abertura: 'abc' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/config', payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/config', payload: { outro: 1 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/caixa?ate=2026-13-01' })).statusCode).toBe(400)
    await app.close()
  })

  it('receitas-avulsas: POST 201, validação, 404 e 204', async () => {
    // Vencimento = hoje (SP): fica 'pendente' em qualquer dia do calendário; com data fixa o teste
    // passava a ser 'atrasado' assim que o dia fixado ficava para trás.
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const row = { id: ID, descricao: 'Aporte', grupo: 'aporte', valor_previsto: '5000', valor_pago: '0', data_vencimento: hoje, data_pagamento: null, competencia: `${hoje.slice(0, 7)}-01`, observacao: null }
    let existe = true
    const db = mockDb({
      INSERT: () => ({ rows: [row] }),
      DELETE: () => ({ rows: [], rowCount: 0 }),
      UPDATE: () => ({ rows: [] }),
      // `existe` simula o item sumir: o receber, ao não achar linha no UPDATE, consulta o item para
      // distinguir "não existe" (404) de "está perdida" (409).
      'SELECT id, descricao': () => ({ rows: existe ? [row] : [] }),
    })
    const app = buildApp(db)
    await app.register(financeiroReceitasAvulsasRoutes)
    const criado = await app.inject({ method: 'POST', url: '/v1/financeiro/receitas-avulsas', payload: { descricao: 'Aporte', grupo: 'aporte', valor_previsto: 5000, data_vencimento: hoje } })
    expect(criado.statusCode).toBe(201)
    expect(criado.json()).toMatchObject({ id: ID, natureza: 'receita', origem: 'avulsa', aporte: true, status: 'pendente' })
    expect((await app.inject({ method: 'POST', url: '/v1/financeiro/receitas-avulsas', payload: { descricao: 'x', grupo: 'venda', valor_previsto: 1, data_vencimento: '2026-10-01' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/v1/financeiro/receitas-avulsas', payload: { descricao: 'x', valor_previsto: 0, data_vencimento: '2026-10-01' } })).statusCode).toBe(400)
    const lista = await app.inject({ method: 'GET', url: '/v1/financeiro/receitas-avulsas?mes=2026-10' })
    expect(lista.json()).toMatchObject({ inicio: '2026-10', fim: '2026-10', totais: { previsto: 5000, pago: 0, aportes: { previsto: 5000, pago: 0 } } })
    existe = false
    expect((await app.inject({ method: 'DELETE', url: `/v1/financeiro/receitas-avulsas/${ID}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas-avulsas/${ID}/receber`, payload: {} })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/receitas-avulsas/abc/desfazer' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas-avulsas/${ID}`, payload: {} })).statusCode).toBe(400)
    await app.close()
  })
})
