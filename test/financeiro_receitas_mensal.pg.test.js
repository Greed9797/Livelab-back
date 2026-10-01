// Integração com Postgres real da aba Receita (GET /v1/financeiro/receita).
// Só roda com TEST_PG_URL (ex.: postgres://postgres@127.0.0.1:55441/db) num banco com o
// schema completo (scripts/setup_fresh_schema.js + apply_migrations.js).
// Invariantes: competencia.total.previsto == calcularDre().receita.previsto e
// vencimento.total.previsto == calcularFluxoCaixa().totais.entradas.previsto.
import fs from 'node:fs'
import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import { atualizarConfigFinanceiro, calcularDre, calcularFluxoCaixa } from '../src/services/financeiro-agregador.js'
import { criarReceitaAvulsa } from '../src/services/receitas-avulsas.js'
import { consultarReceitaMensal, receberTitulo } from '../src/services/receitas-comercial.js'
import { financeiroReceitasRoutes } from '../src/routes/financeiro_receitas.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-10-15'

describe.skipIf(!url)('aba Receita (Postgres real)', () => {
  let pool
  let t
  let t2
  const ids = {}
  const q = (sql, params) => pool.query(sql, params)

  const marca = async (tenant, nome, c) => {
    const cliente = (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, $2, '47999999999', 'ativo') RETURNING id`,
      [tenant, `Cliente ${nome}`],
    )).rows[0].id
    const id = (await q(
      `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio) VALUES ($1, $2, $3, 'cliente', '2026-08-01') RETURNING id`,
      [tenant, cliente, nome],
    )).rows[0].id
    await q(
      `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
         tipo_cobranca, fixo_confirmado, comissao_confirmada, origem, comissao_vencimento_dia, comissao_vencimento_mes_offset)
       VALUES ($1, $2, '2026-08-01', $3, $4, $5, true, true, 'gestao', $6, $7)`,
      [tenant, id, c.fixo, c.pct, c.tipo ?? 'fixo_mais_comissao', c.cd ?? 5, c.co ?? 1],
    )
    return id
  }
  const live = (tenant, marcaId, iniciadoEm, gmv) => q(
    `INSERT INTO lives (tenant_id, marca_id, status, iniciado_em, encerrado_em, fat_gerado)
     VALUES ($1, $2, 'encerrada', $3::timestamptz, $3::timestamptz + interval '2 hours', $4)`,
    [tenant, marcaId, iniciadoEm, gmv],
  )
  const marcaDe = (r, id) => r.competencia.clientes.flatMap((c) => c.marcas).find((m) => m.marca_id === id)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-receita-mensal') RETURNING id`)).rows[0].id
    t2 = (await q(`INSERT INTO tenants (nome) VALUES ('t-receita-mensal-outro') RETURNING id`)).rows[0].id

    // A: GMV + % (fixo 1000 + 10%, comissão vence dia 20 do próprio mês)
    ids.A = await marca(t, 'Alfa', { fixo: 1000, pct: 10, cd: 20, co: 0 })
    await live(t, ids.A, '2026-09-10T15:00:00-03:00', 3000)
    await live(t, ids.A, '2026-10-05T15:00:00-03:00', 5000) // mês corrente: GMV até hoje
    // B: só fixo
    ids.B = await marca(t, 'Beta', { fixo: 800, pct: 0 })
    await live(t, ids.B, '2026-09-11T15:00:00-03:00', 4000)
    // C: só % (sem live em 10 → em apuração)
    ids.C = await marca(t, 'Gama', { fixo: 0, pct: 8 })
    await live(t, ids.C, '2026-09-12T15:00:00-03:00', 10000)
    // D: fixo OU comissão (2000 ou 5%): 09 bruta 2500 (excedente 500); 10 bruta 500 (< fixo)
    ids.D = await marca(t, 'Delta', { fixo: 2000, pct: 5, tipo: 'fixo_ou_comissao' })
    await live(t, ids.D, '2026-09-13T15:00:00-03:00', 50000)
    await live(t, ids.D, '2026-10-02T15:00:00-03:00', 10000)
    // E: GMV + % sem GMV nenhum
    ids.E = await marca(t, 'Epsilon', { fixo: 500, pct: 10 })

    // Fixo A de 08 (vence 05/09) recebido 04/09; comissão A de 09 (vence 20/09) parcial 100 em 21/09.
    await receberTitulo(pool, { tenantId: t, id: `calc:${ids.A}:2026-08:fixo`, dataPagamento: '2026-09-04', hoje: HOJE })
    await receberTitulo(pool, { tenantId: t, id: `calc:${ids.A}:2026-09:comissao`, valorPago: 100, dataPagamento: '2026-09-21', hoje: HOJE })
    await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Consultoria', grupo: 'servico', valor_previsto: 300, data_vencimento: '2026-09-20' }, hoje: HOJE })
    await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Aporte sócio', grupo: 'aporte', valor_previsto: 1000, data_vencimento: '2026-10-01', valor_pago: 1000, data_pagamento: '2026-10-01' }, hoje: HOJE })
    await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Reembolso', grupo: 'reembolso', valor_previsto: 50, data_vencimento: '2026-10-10', competencia: '2026-09-01' }, hoje: HOJE })

    // Outro tenant: nunca aparece.
    const x = await marca(t2, 'Alfa', { fixo: 999, pct: 50 })
    await live(t2, x, '2026-09-10T15:00:00-03:00', 10000)
  })

  afterAll(async () => {
    if (!pool) return
    for (const tb of ['receitas_avulsas', 'receita_titulos', 'lives', 'marca_condicoes_comerciais', 'marcas', 'clientes']) {
      await q(`DELETE FROM ${tb} WHERE tenant_id = ANY($1::uuid[])`, [[t, t2]]).catch(() => {})
    }
    await q('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {})
    await pool.end()
  })

  it('modalidades na competência 09: GMV+%, só fixo, só %, fixo OU comissão e sem GMV', async () => {
    const r = await consultarReceitaMensal(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })
    expect(marcaDe(r, ids.A)).toMatchObject({
      pct: 10, gmv: 3000, comissao_bruta: 300, em_apuracao: false,
      fixo: { valor_previsto: 1000, virtual: true, data_vencimento: '2026-10-05' },
      comissao: { valor_previsto: 300, valor_pago: 100, virtual: false, status: 'atrasado' },
    })
    expect(marcaDe(r, ids.B)).toMatchObject({ pct: 0, gmv: 4000, comissao: null, em_apuracao: false, fixo: { valor_previsto: 800 } })
    expect(marcaDe(r, ids.C)).toMatchObject({ pct: 8, fixo: null, comissao: { valor_previsto: 800 } })
    expect(marcaDe(r, ids.D)).toMatchObject({
      tipo_cobranca: 'fixo_ou_comissao', gmv: 50000, comissao_bruta: 2500,
      fixo: { valor_previsto: 2000 }, comissao: { valor_previsto: 500 }, total: { previsto: 2500 },
    })
    expect(marcaDe(r, ids.E)).toMatchObject({ gmv: 0, pct: 10, comissao: null, em_apuracao: true, fixo: { valor_previsto: 500 } })
    expect(r.competencia.avulsas.map((a) => a.descricao).sort()).toEqual(['Consultoria', 'Reembolso'])
    expect(r.competencia.clientes.some((c) => c.cliente_nome === 'Cliente Alfa' && c.marcas.length === 1)).toBe(true)
  })

  it('mês corrente (10): comissão = GMV até hoje × %; abaixo do fixo e sem GMV ficam em apuração', async () => {
    const r = await consultarReceitaMensal(pool, { tenantId: t, mes: '2026-10', hoje: HOJE })
    expect(marcaDe(r, ids.A)).toMatchObject({ gmv: 5000, comissao: { valor_previsto: 500, data_vencimento: '2026-10-20' } })
    expect(marcaDe(r, ids.D)).toMatchObject({ gmv: 10000, comissao_bruta: 500, comissao: null, em_apuracao: true })
    expect(marcaDe(r, ids.C)).toMatchObject({ em_apuracao: true, comissao: null, fixo: null, pct: 8 })
    expect(r.competencia.aportes.map((a) => a.descricao)).toEqual(['Aporte sócio'])
    expect(r.a_receber_mes).toBe(r.vencimento.total.aberto)
  })

  it.each(['2026-08', '2026-09', '2026-10', '2026-11'])('invariantes %s: competência == DRE e vencimento == fluxo', async (mes) => {
    const [r, dre, fluxo] = await Promise.all([
      consultarReceitaMensal(pool, { tenantId: t, mes, hoje: HOJE }),
      calcularDre(pool, { tenantId: t, inicio: mes, fim: mes, hoje: HOJE }),
      calcularFluxoCaixa(pool, { tenantId: t, mes, saldoInicial: 0, hoje: HOJE }),
    ])
    expect(r.competencia.total.previsto).toBe(dre.meses[0].receita.previsto)
    expect(r.competencia.total.pago).toBe(dre.meses[0].receita.realizado)
    expect(r.vencimento.total.previsto).toBe(fluxo.totais.entradas.previsto)
    expect(r.competencia.total.previsto).toBeGreaterThan(0)
  })

  it('corte: itens antes de 01/10 saem e as invariantes continuam valendo', async () => {
    await atualizarConfigFinanceiro(pool, t, { data_corte: '2026-10-01' })
    try {
      const r9 = await consultarReceitaMensal(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })
      expect(r9.corte).toEqual({ data_corte: '2026-10-01' })
      // comissão A de 09 venceu 20/09 (pago 21/09) → fora; não vira "em apuração"
      expect(marcaDe(r9, ids.A)).toMatchObject({ comissao: null, em_apuracao: false, fixo: { valor_previsto: 1000 } })
      expect(r9.competencia.avulsas.map((a) => a.descricao)).toEqual(['Reembolso'])
      expect(r9.vencimento.itens).toEqual([])
      for (const mes of ['2026-09', '2026-10']) {
        const [r, dre, fluxo] = await Promise.all([
          consultarReceitaMensal(pool, { tenantId: t, mes, hoje: HOJE }),
          calcularDre(pool, { tenantId: t, inicio: mes, fim: mes, hoje: HOJE }),
          calcularFluxoCaixa(pool, { tenantId: t, mes, saldoInicial: 0, hoje: HOJE }),
        ])
        expect(r.competencia.total.previsto).toBe(dre.meses[0].receita.previsto)
        expect(r.vencimento.total.previsto).toBe(fluxo.totais.entradas.previsto)
      }
      // 08: tudo venceu antes do corte; marca em apuração (C venceria 05/09) não aparece
      const r8 = await consultarReceitaMensal(pool, { tenantId: t, mes: '2026-08', hoje: HOJE })
      expect(r8.competencia.clientes).toEqual([])
      expect(r8.competencia.total.previsto).toBe(0)
    } finally {
      await atualizarConfigFinanceiro(pool, t, { data_corte: null })
    }
  })

  it('rota: tenant explícito (o outro tenant nunca aparece)', async () => {
    const app = Fastify()
    app.decorate('authenticate', async (request) => { request.user = { tenant_id: t, sub: null, papel: 'financeiro' } })
    app.decorate('requirePapel', () => async () => {})
    app.decorate('withTenant', async (_tenant, fn) => fn(pool))
    await app.register(financeiroReceitasRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/receita?mes=2026-09' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const marcas = body.competencia.clientes.flatMap((c) => c.marcas)
    expect(marcas.map((m) => m.marca_id).sort()).toEqual([ids.A, ids.B, ids.C, ids.D, ids.E].sort())
    if (process.env.PRINT_RECEITA_JSON) fs.writeFileSync(process.env.PRINT_RECEITA_JSON, JSON.stringify(body, null, 2))
    await app.close()
  })
})
