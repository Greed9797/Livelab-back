// Aba Receita: GET /v1/financeiro/receita (montarReceitaMensal / consultarReceitaMensal).
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { marcasCondicaoVigenteMesSql, receitaMarcaMensalSql } from '../src/lib/receita-marca-sql.js'
import { financeiroReceitasRoutes } from '../src/routes/financeiro_receitas.js'
import { aplicarCorte, montarDre, montarFluxoCaixa, normalizarReceita } from '../src/services/financeiro-agregador.js'
import { calcularReceitasComerciais, consultarReceitaMensal, montarReceitaMensal } from '../src/services/receitas-comercial.js'

const tenantId = '00000000-0000-4000-8000-000000000001'
const U = (n) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`
const HOJE = '2026-10-15'

function titulo({ marca, componente, competencia, valor, venc, pago = 0, dataPagamento = null, tipo = 'fixo_mais_comissao', pct = 10 }) {
  return {
    id: `calc:${marca.id}:${competencia.slice(0, 7)}:${componente}`,
    natureza: 'receita',
    origem: 'comercial',
    componente,
    descricao: `${componente} — ${marca.nome}`,
    competencia,
    data_vencimento: venc,
    valor_previsto: valor,
    valor_pago: pago,
    data_pagamento: dataPagamento,
    marca_id: marca.id,
    marca_nome: marca.nome,
    cliente_id: marca.cliente_id,
    cliente_nome: `Cliente ${marca.nome}`,
    tipo_cobranca: tipo,
    materializado: pago > 0,
    valor_calculado: valor,
    divergente: false,
    memoria: { pct },
    status: pago >= valor ? 'pago' : 'previsto',
  }
}
const linha = (marca, { gmv = 0, comissao = 0, pct = 10, tipo = 'fixo_mais_comissao', competencia = '2026-09-01' } = {}) => ({
  marca_id: marca.id, competencia, gmv, comissao, comissao_franquia_pct: pct, tipo_cobranca: tipo,
  marca_nome: marca.nome, cliente_id: marca.cliente_id, cliente_nome: `Cliente ${marca.nome}`,
})
const vigente = (marca, { pct = 10, tipo = 'fixo_mais_comissao', cd = 5, co = 1 } = {}) => ({
  marca_id: marca.id, marca_nome: marca.nome, cliente_id: marca.cliente_id, cliente_nome: `Cliente ${marca.nome}`,
  tipo_cobranca: tipo, comissao_franquia_pct: pct, comissao_vencimento_dia: cd, comissao_vencimento_mes_offset: co,
})
const avulsa = ({ id, grupo = 'servico', valor, competencia, venc, pago = 0, dataPagamento = null }) => ({
  id, natureza: 'receita', origem: 'avulsa', grupo, descricao: `Avulsa ${id}`, competencia, data_vencimento: venc,
  data_pagamento: dataPagamento, valor_previsto: valor, valor_pago: pago, aporte: grupo === 'aporte', virtual: false,
  status: pago >= valor ? 'pago' : 'previsto',
})

const A = { id: U(1), nome: 'Alfa', cliente_id: U(11) } // GMV + %
const B = { id: U(2), nome: 'Beta', cliente_id: U(12) } // só fixo
const C = { id: U(3), nome: 'Gama', cliente_id: U(13) } // só %
const D = { id: U(4), nome: 'Delta', cliente_id: U(14) } // fixo OU comissão
const E = { id: U(5), nome: 'Épsilon', cliente_id: U(15) } // GMV + %, sem GMV

function cenarioSetembro() {
  const titulos = [
    // competência 08 (vencimentos em 09)
    titulo({ marca: A, componente: 'fixo', competencia: '2026-08-01', valor: 1000, venc: '2026-09-05', pago: 1000, dataPagamento: '2026-09-04' }),
    // competência 09
    titulo({ marca: A, componente: 'fixo', competencia: '2026-09-01', valor: 1000, venc: '2026-10-05' }),
    titulo({ marca: A, componente: 'comissao', competencia: '2026-09-01', valor: 300, venc: '2026-09-20', pago: 100, dataPagamento: '2026-09-21' }),
    titulo({ marca: B, componente: 'fixo', competencia: '2026-09-01', valor: 800, venc: '2026-10-05', pct: 0 }),
    titulo({ marca: C, componente: 'comissao', competencia: '2026-09-01', valor: 800, venc: '2026-10-05', pct: 8 }),
    titulo({ marca: D, componente: 'fixo', competencia: '2026-09-01', valor: 2000, venc: '2026-10-05', tipo: 'fixo_ou_comissao', pct: 5 }),
    titulo({ marca: D, componente: 'comissao', competencia: '2026-09-01', valor: 500, venc: '2026-10-05', tipo: 'fixo_ou_comissao', pct: 5 }),
    titulo({ marca: E, componente: 'fixo', competencia: '2026-09-01', valor: 500, venc: '2026-10-05' }),
  ]
  const linhasMarca = [
    linha(A, { gmv: 3000, comissao: 300 }),
    linha(B, { pct: 0 }),
    linha(C, { gmv: 10000, comissao: 800, pct: 8 }),
    linha(D, { gmv: 50000, comissao: 2500, pct: 5, tipo: 'fixo_ou_comissao' }),
    linha(E, {}),
  ]
  const marcasVigentes = [
    vigente(A, { cd: 20, co: 0 }), vigente(B, { pct: 0 }), vigente(C, { pct: 8 }),
    vigente(D, { pct: 5, tipo: 'fixo_ou_comissao' }), vigente(E),
  ]
  const avulsas = [
    avulsa({ id: U(21), valor: 300, competencia: '2026-09-01', venc: '2026-09-20' }),
    avulsa({ id: U(22), grupo: 'aporte', valor: 1000, competencia: '2026-09-01', venc: '2026-09-01', pago: 1000, dataPagamento: '2026-09-01' }),
    // competência 08, vence em 09 (só na visão vencimento)
    avulsa({ id: U(23), valor: 50, competencia: '2026-08-01', venc: '2026-09-10' }),
  ]
  return { titulos, linhasMarca, marcasVigentes, avulsas }
}

const marcaNoResultado = (r, marcaId) => r.competencia.clientes.flatMap((c) => c.marcas).find((m) => m.marca_id === marcaId)

describe('montarReceitaMensal — competência', () => {
  const r = montarReceitaMensal({ mes: '2026-09', hoje: HOJE, ...cenarioSetembro() })

  it('modalidades: GMV+%, só fixo, só %, fixo OU comissão (comissão = excedente) e sem GMV', () => {
    expect(marcaNoResultado(r, A.id)).toMatchObject({
      tipo_cobranca: 'fixo_mais_comissao', pct: 10, gmv: 3000, comissao_bruta: 300, em_apuracao: false,
      fixo: { componente: 'fixo', valor_previsto: 1000, virtual: true }, comissao: { valor_previsto: 300, valor_pago: 100 },
      total: { previsto: 1300, pago: 100 },
    })
    expect(marcaNoResultado(r, B.id)).toMatchObject({ pct: 0, comissao: null, em_apuracao: false, total: { previsto: 800 } })
    expect(marcaNoResultado(r, C.id)).toMatchObject({ pct: 8, fixo: null, comissao: { valor_previsto: 800 }, em_apuracao: false })
    expect(marcaNoResultado(r, D.id)).toMatchObject({
      tipo_cobranca: 'fixo_ou_comissao', gmv: 50000, comissao_bruta: 2500,
      fixo: { valor_previsto: 2000 }, comissao: { valor_previsto: 500 }, total: { previsto: 2500 },
    })
    expect(marcaNoResultado(r, E.id)).toMatchObject({ gmv: 0, comissao_bruta: 0, pct: 10, comissao: null, em_apuracao: true, fixo: { valor_previsto: 500 } })
  })

  it('agrupa por cliente, avulsas e aportes em blocos; aporte fora do total', () => {
    expect(r.competencia.clientes.map((c) => c.cliente_nome)).toEqual(['Cliente Alfa', 'Cliente Beta', 'Cliente Delta', 'Cliente Épsilon', 'Cliente Gama'])
    expect(r.competencia.clientes[0].total).toEqual({ previsto: 1300, pago: 100, perdido: 0 })
    expect(r.competencia.avulsas.map((a) => a.id)).toEqual([U(21)])
    expect(r.competencia.aportes.map((a) => a.id)).toEqual([U(22)])
    // 1300 + 800 + 800 + 2500 + 500 + 300 (avulsa) — sem o aporte de 1000
    expect(r.competencia.total).toEqual({ previsto: 6200, pago: 100, aberto: 6100, perdido: 0 })
  })

  it('invariante: competência == DRE.receita.previsto e vencimento == entradas do fluxo', () => {
    const { titulos, avulsas } = cenarioSetembro()
    const itens = [...titulos.map((t) => normalizarReceita(t, HOJE)), ...avulsas]
    const dre = montarDre({ meses: ['2026-09'], itens })
    expect(r.competencia.total.previsto).toBe(dre.meses[0].receita.previsto)
    expect(r.competencia.total.pago).toBe(dre.meses[0].receita.realizado)
    const fluxo = montarFluxoCaixa({ mes: '2026-09', itens })
    expect(r.vencimento.total.previsto).toBe(fluxo.totais.entradas.previsto)
  })
})

describe('montarReceitaMensal — vencimento e a receber', () => {
  it('lista o que vence no mês (inclui competência anterior e aporte) e a_receber = em aberto', () => {
    const r = montarReceitaMensal({ mes: '2026-09', hoje: HOJE, ...cenarioSetembro() })
    expect(r.vencimento.itens.map((i) => [i.data_vencimento, i.tipo, i.componente ?? null])).toEqual([
      ['2026-09-01', 'aporte', null],
      ['2026-09-05', 'titulo', 'fixo'],
      ['2026-09-10', 'avulsa', null],
      ['2026-09-20', 'avulsa', null],
      ['2026-09-20', 'titulo', 'comissao'],
    ])
    expect(r.vencimento.total).toEqual({ previsto: 2650, pago: 2100, aberto: 550, perdido: 0 })
    expect(r.a_receber_mes).toBe(550)
    expect(r.vencimento.itens[1]).toMatchObject({ cliente_nome: 'Cliente Alfa', marca_nome: 'Alfa', descricao: expect.any(String) })
  })

  it('segue o saldo canônico para perda parcial, perda total, cancelamento e quitação', () => {
    const avulsaCom = (id, extra) => ({
      ...avulsa({ id, valor: extra.valor_previsto, competencia: '2026-09-01', venc: '2026-09-20', pago: extra.valor_pago ?? 0 }),
      ...extra,
    })
    const r = montarReceitaMensal({
      mes: '2026-09', hoje: HOJE,
      avulsas: [
        avulsaCom(U(31), { valor_previsto: 100, valor_pago: 10, valor_perdido: 40, status: 'atrasado' }),
        avulsaCom(U(32), { valor_previsto: 50, perdido_em: '2026-09-14T10:00:00.000Z', status: 'perdido' }),
        avulsaCom(U(33), { valor_previsto: 30, cancelado_em: '2026-09-14T10:00:00.000Z', status: 'cancelado' }),
        avulsaCom(U(34), { valor_previsto: 70, valor_pago: 70, perdido_em: '2026-09-14T10:00:00.000Z', status: 'pago' }),
      ],
    })
    expect(r.competencia.total).toEqual({ previsto: 250, pago: 80, aberto: 50, perdido: 120 })
    expect(r.vencimento.total).toEqual({ previsto: 250, pago: 80, aberto: 50, perdido: 120 })
    expect(r.a_receber_mes).toBe(50)
  })
})

describe('montarReceitaMensal — corte', () => {
  it('previsão por vencimento não muda de período por causa da data da baixa', () => {
    const r = montarReceitaMensal({
      mes: '2026-10', hoje: HOJE, dataCorte: '2026-10-01',
      titulos: [titulo({ marca: A, componente: 'fixo', competencia: '2026-09-01', venc: '2026-10-05', valor: 1000, pago: 1000, dataPagamento: '2026-09-30' })],
    })
    expect(r.vencimento.total).toEqual({ previsto: 1000, pago: 1000, aberto: 0, perdido: 0 })
  })
  it('itens com data efetiva antes do corte saem das duas visões; invariantes continuam', () => {
    const cen = cenarioSetembro()
    const r = montarReceitaMensal({ mes: '2026-09', hoje: HOJE, dataCorte: '2026-10-01', ...cen })
    expect(r.corte).toEqual({ data_corte: '2026-10-01' })
    // comissão A (vence 20/09, pago 21/09) cortada; não vira "em apuração"
    expect(marcaNoResultado(r, A.id)).toMatchObject({ comissao: null, em_apuracao: false, fixo: { valor_previsto: 1000 } })
    expect(r.competencia.avulsas).toEqual([]) // avulsa vence 20/09
    expect(r.competencia.aportes).toEqual([])
    expect(r.vencimento.itens).toEqual([])
    expect(r.a_receber_mes).toBe(0)

    const itens = aplicarCorte([...cen.titulos.map((t) => normalizarReceita(t, HOJE)), ...cen.avulsas], '2026-10-01')
    const dre = montarDre({ meses: ['2026-09'], itens })
    expect(r.competencia.total.previsto).toBe(dre.meses[0].receita.previsto)
  })

  it('marca em apuração cujo vencimento da comissão cai antes do corte não aparece', () => {
    const r = montarReceitaMensal({
      mes: '2026-08', hoje: HOJE, dataCorte: '2026-10-01',
      marcasVigentes: [vigente(C, { pct: 8 })], // comissão 08 venceria 05/09 < corte
    })
    expect(r.competencia.clientes).toEqual([])
    const r2 = montarReceitaMensal({ mes: '2026-09', hoje: HOJE, dataCorte: '2026-10-01', marcasVigentes: [vigente(C, { pct: 8 })] })
    expect(marcaNoResultado(r2, C.id)).toMatchObject({ em_apuracao: true, comissao: null, fixo: null, pct: 8, total: { previsto: 0, pago: 0 } })
  })
})

describe('montarReceitaMensal — mês corrente', () => {
  it('comissão = GMV até hoje × %; fixo OU comissão abaixo do fixo fica em apuração com a bruta visível', () => {
    const r = montarReceitaMensal({
      mes: '2026-10', hoje: HOJE,
      titulos: [
        titulo({ marca: A, componente: 'fixo', competencia: '2026-10-01', valor: 1000, venc: '2026-11-05' }),
        titulo({ marca: A, componente: 'comissao', competencia: '2026-10-01', valor: 500, venc: '2026-10-20' }),
        titulo({ marca: D, componente: 'fixo', competencia: '2026-10-01', valor: 2000, venc: '2026-11-05', tipo: 'fixo_ou_comissao', pct: 5 }),
      ],
      linhasMarca: [
        linha(A, { gmv: 5000, comissao: 500, competencia: '2026-10-01' }),
        linha(D, { gmv: 10000, comissao: 500, pct: 5, tipo: 'fixo_ou_comissao', competencia: '2026-10-01' }),
      ],
      marcasVigentes: [vigente(A, { cd: 20, co: 0 }), vigente(D, { pct: 5, tipo: 'fixo_ou_comissao' }), vigente(C, { pct: 8 })],
    })
    expect(r).toMatchObject({ mes: '2026-10', hoje: HOJE, corte: { data_corte: null } })
    expect(marcaNoResultado(r, A.id)).toMatchObject({ gmv: 5000, comissao: { valor_previsto: 500 }, em_apuracao: false })
    expect(marcaNoResultado(r, D.id)).toMatchObject({ gmv: 10000, comissao_bruta: 500, comissao: null, em_apuracao: true })
    expect(marcaNoResultado(r, C.id)).toMatchObject({ em_apuracao: true, comissao: null, fixo: null })
    expect(r.competencia.total.previsto).toBe(3500)
    expect(r.vencimento.total.previsto).toBe(500)
  })

  it('rejeita mes inválido', () => {
    expect(() => montarReceitaMensal({ mes: '2026-13' })).toThrow(/AAAA-MM/)
  })
})

describe('SQL', () => {
  it('receitaMarcaMensalSql expõe o pct da condição vigente; marcas vigentes filtram tipo cliente/contrato', () => {
    expect(receitaMarcaMensalSql()).toContain('COALESCE(mc.comissao_franquia_pct, 0) AS comissao_franquia_pct')
    const sql = marcasCondicaoVigenteMesSql()
    expect(sql).toContain("m.tipo = 'cliente'")
    expect(sql).toContain('m.tenant_id = $3::uuid')
    expect(sql).toContain('m.data_fim >= $1::date')
  })

  it('pct propagado em memoria dos títulos calculados', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        marca_id: A.id, competencia: '2026-09-01', comissao: '300', gmv: '3000', fixo: '1000', fixo_cheio: '1000', fator_meses: '1',
        marca_nome: 'Alfa', marca_tipo: 'cliente', cliente_id: A.cliente_id, cliente_nome: 'Cliente Alfa', condicao_id: U(30),
        tipo_cobranca: 'fixo_mais_comissao', comissao_franquia_pct: '10.00',
        fixo_vencimento_dia: 5, fixo_vencimento_mes_offset: 1, comissao_vencimento_dia: 5, comissao_vencimento_mes_offset: 1,
      }],
    }))
    const itens = await calcularReceitasComerciais({ query }, { tenantId, inicio: '2026-09' })
    expect(itens.map((i) => i.memoria.pct)).toEqual([10, 10])
  })
})

describe('consultarReceitaMensal / rota GET /v1/financeiro/receita', () => {
  const dbMock = () => vi.fn(async (sql) => {
    const text = String(sql)
    if (text.includes('FROM tenants')) return { rows: [{ aliquota_imposto_pct: 10, data_corte: null, saldo_abertura: 0 }] }
    if (text.includes('WITH comissao_marca')) return { rows: [] }
    if (text.includes("m.tipo = 'cliente'") && text.includes('ORDER BY m.nome')) {
      return { rows: [{ ...vigente(E), condicao_id: U(31), fixo_mensal: 0 }] }
    }
    return { rows: [] }
  })

  it('tenant explícito em todas as queries e janelas de competência', async () => {
    const query = dbMock()
    const r = await consultarReceitaMensal({ query }, { tenantId, mes: '2026-10', hoje: HOJE })
    expect(marcaNoResultado(r, E.id)).toMatchObject({ em_apuracao: true })
    for (const [, params] of query.mock.calls) expect(params).toContain(tenantId)
    const vig = query.mock.calls.find(([sql]) => String(sql).includes('ORDER BY m.nome'))
    expect(vig[1]).toEqual(['2026-10-01', '2026-10-31', tenantId])
    const avul = query.mock.calls.find(([sql]) => String(sql).includes('FROM receitas_avulsas'))
    expect(avul[1]).toEqual([tenantId, '2026-10-01', '2026-10-01', '2026-10-31', '2026-10-01'])
  })

  function buildApp(query, papel = 'financeiro_readonly') {
    const app = Fastify()
    app.decorate('authenticate', async (request) => { request.user = { tenant_id: tenantId, sub: U(40), papel } })
    app.decorate('requirePapel', (roles) => async (request, reply) => {
      if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'Acesso negado' })
    })
    app.decorate('withTenant', async (tenant, fn) => {
      expect(tenant).toBe(tenantId)
      return fn({ query })
    })
    return app
  }

  it('READ_FINANCEIRO, valida mes e devolve o contrato', async () => {
    const app = buildApp(dbMock())
    await app.register(financeiroReceitasRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/receita?mes=2026-10' })
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json())).toEqual(['mes', 'hoje', 'corte', 'competencia', 'vencimento', 'a_receber_mes', 'recebimentos_mes', 'reconciliacao'])
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/receita?mes=2026-1' })).statusCode).toBe(400)
    await app.close()

    const proibido = buildApp(dbMock(), 'apresentador')
    await proibido.register(financeiroReceitasRoutes)
    expect((await proibido.inject({ method: 'GET', url: '/v1/financeiro/receita' })).statusCode).toBe(403)
    await proibido.close()
  })
})
