// Integração com Postgres real (SPEC v3 / B2): classe_custo (migration 171), DRE com
// custos fixos/variáveis e GET /v1/financeiro/dre/mes. Só roda com TEST_PG_URL num banco
// com o schema completo (scripts/setup_fresh_schema.js + apply_migrations.js, incluindo 171).
import fs from 'node:fs'
import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import { atualizarConfigFinanceiro, calcularDre, calcularDreMes, listarLancamentos } from '../src/services/financeiro-agregador.js'
import { listarCustos, materializarVirtual } from '../src/services/custos-plano.js'
import { receberTitulo } from '../src/services/receitas-comercial.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { financeiroCustosRoutes } from '../src/routes/financeiro_custos.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-10-15'
const r2 = (v) => Math.round(v * 100) / 100
const soma = (xs) => r2(xs.reduce((s, x) => s + x, 0))

describe.skipIf(!url)('financeiro: classe do custo e DRE do mês (Postgres real)', () => {
  let pool
  let t
  let t2
  let marcaId
  let energiaId
  const q = (sql, params) => pool.query(sql, params)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    const sql = fs.readFileSync('migrations/171_custos_classe.sql', 'utf8')
    await q(sql)
    await q(sql) // reaplicável
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-dre-classe') RETURNING id`)).rows[0].id
    t2 = (await q(`INSERT INTO tenants (nome) VALUES ('t-dre-classe-outro') RETURNING id`)).rows[0].id

    const cliente = (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, 'Cliente D', '47999999997', 'ativo') RETURNING id`, [t],
    )).rows[0].id
    marcaId = (await q(
      `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio) VALUES ($1, $2, 'Marca D', 'cliente', '2026-06-01') RETURNING id`,
      [t, cliente],
    )).rows[0].id
    await q(
      `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
         tipo_cobranca, fixo_confirmado, comissao_confirmada, origem)
       VALUES ($1, $2, '2026-06-01', 1000, 10, 'fixo_mais_comissao', true, true, 'gestao')`, [t, marcaId],
    )
    await q(
      `INSERT INTO lives (tenant_id, marca_id, status, iniciado_em, encerrado_em, fat_gerado)
       VALUES ($1, $2, 'encerrada', '2026-10-05T15:00:00-03:00', '2026-10-05T17:00:00-03:00', 5000)`, [t, marcaId],
    )
    // Fixo de setembro (vence 05/10) recebido em 06/10 → realizado de setembro.
    await receberTitulo(pool, { tenantId: t, id: `calc:${marcaId}:2026-09:fixo`, dataPagamento: '2026-10-06', hoje: HOJE })
    await q(`INSERT INTO custos_recorrentes (tenant_id, nome, grupo, valor, dia_vencimento, inicio)
             VALUES ($1, 'Aluguel', 'estrutural', 300, 10, '2026-01-01')`, [t])
    energiaId = (await q(
      `INSERT INTO custos_recorrentes (tenant_id, nome, grupo, valor, dia_vencimento, inicio, classe_custo)
       VALUES ($1, 'Energia', 'estrutural', 120, 12, '2026-01-01', 'variavel') RETURNING id`, [t],
    )).rows[0].id
    await q(`INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento)
             VALUES ($1, 'Frete', 50, 'outros', 'operacional', '2026-10-01', '2026-10-20')`, [t])
    await q(`INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento, classe_custo)
             VALUES ($1, 'Contador', 150, 'outros', 'operacional', '2026-10-01', '2026-10-20', 'fixo')`, [t])
    await q(`INSERT INTO apresentadoras (tenant_id, nome, fixo) VALUES ($1, 'Ana', 2000)`, [t])
  })

  afterAll(async () => {
    if (!pool) return
    for (const tb of ['receita_titulos', 'custos', 'custos_recorrentes', 'apresentadora_pagamentos', 'lives', 'marca_condicoes_comerciais', 'marcas', 'apresentadoras', 'clientes']) {
      await q(`DELETE FROM ${tb} WHERE tenant_id = ANY($1::uuid[])`, [[t, t2]]).catch(() => {})
    }
    await q('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {})
    await pool.end()
  })

  it('CHECK de classe_custo e herança do override do recorrente (virtual e materializado)', async () => {
    await expect(q(`INSERT INTO custos (tenant_id, descricao, valor, competencia, classe_custo) VALUES ($1, 'x', 1, '2026-10-01', 'semi')`, [t]))
      .rejects.toThrow(/custos_classe_custo_check/)
    let itens = await listarCustos(pool, { tenantId: t, inicio: '2026-10', fim: '2026-10', hoje: HOJE })
    const classe = () => Object.fromEntries(itens.map((i) => [i.descricao, i.classe]))
    expect(classe()).toEqual({ Aluguel: 'fixo', Energia: 'variavel', Frete: 'variavel', Contador: 'fixo' })
    await materializarVirtual(pool, { tenantId: t, recorrente_id: energiaId, mes: '2026-10' })
    itens = await listarCustos(pool, { tenantId: t, inicio: '2026-10', fim: '2026-10', hoje: HOJE })
    expect(itens.find((i) => i.descricao === 'Energia')).toMatchObject({ virtual: false, classe: 'variavel', classe_custo: null, classe_custo_recorrente: 'variavel' })
  })

  it('lançamentos: todo custo tem classe; apresentadora por componente', async () => {
    const itens = await listarLancamentos(pool, { tenantId: t, inicio: '2026-10', fim: '2026-10', hoje: HOJE })
    const custos = itens.filter((i) => i.natureza === 'custo')
    expect(custos.every((i) => i.classe === 'fixo' || i.classe === 'variavel')).toBe(true)
    for (const a of custos.filter((i) => i.origem === 'apresentadora')) expect(a.classe).toBe(a.componente === 'fixo' ? 'fixo' : 'variavel')
    expect(custos.find((i) => i.origem === 'imposto')?.classe ?? 'variavel').toBe('variavel')
  })

  it('DRE: resultado = receita − fixos − variáveis (= fórmula legada)', async () => {
    const dre = await calcularDre(pool, { tenantId: t, inicio: '2026-09', fim: '2026-10', hoje: HOJE })
    for (const m of dre.meses) {
      for (const k of ['previsto', 'realizado']) {
        expect(m.resultado[k]).toBe(r2(m.receita[k] - m.custos_fixos[k] - m.custos_variaveis[k]))
        expect(r2(m.custos_fixos[k] + m.custos_variaveis[k])).toBe(r2(m.custos[k] + m.apresentadoras[k] + m.imposto[k]))
      }
    }
  })

  it('GET /dre/mes: contrato, invariantes, corte e tenant explícito', async () => {
    const app = Fastify()
    let tenantDaReq = t
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: tenantDaReq, papel: 'franqueado' } })
    app.decorate('withTenant', async (_tenant, fn) => fn(pool))
    app.decorate('audit', { log: async () => {} })
    await app.register(financeiroRoutes)
    await app.register(financeiroCustosRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/dre/mes?mes=2026-10' })
    expect(res.statusCode).toBe(200)
    const d = res.json()
    expect(d).toMatchObject({ mes: '2026-10', mes_anterior: '2026-09', atual: { mes: '2026-10' }, anterior: { mes: '2026-09' } })
    const marca = d.receita.por_cliente[0].marcas[0]
    expect(marca).toMatchObject({ marca_nome: 'Marca D', fixo: { previsto: 1000, realizado: 0 }, comissao: { previsto: 500 }, gmv: 5000, pct: 10 })
    expect(d.receita.total.previsto).toBe(1500)
    expect(d.anterior.receita).toEqual({ previsto: 1000, realizado: 1000 })
    expect(d.delta.receita).toEqual({ previsto: 500, realizado: -1000 })

    const cf = d.custos_fixos
    expect(soma([...cf.por_grupo.map((g) => g.total.previsto), ...cf.apresentadoras_fixo.map((a) => a.previsto)])).toBe(cf.total.previsto)
    expect(cf.por_grupo.flatMap((g) => g.itens.map((i) => i.descricao)).sort()).toEqual(['Aluguel', 'Contador'])
    expect(cf.apresentadoras_fixo.map((a) => a.nome)).toEqual(['Ana'])
    const cv = d.custos_variaveis
    expect(cv.por_grupo.flatMap((g) => g.itens.map((i) => i.descricao)).sort()).toEqual(['Energia', 'Frete'])
    expect(soma([...cv.por_grupo.map((g) => g.total.previsto), ...cv.apresentadoras_variavel.map((a) => a.previsto), cv.imposto.previsto]))
      .toBe(cv.total.previsto)
    // imposto de outubro: base = recebido de setembro (projetado, mês-base corrente)
    expect(cv.imposto).toMatchObject({ aliquota: 10, mes_base: '2026-09' })
    expect(d.atual.resultado.previsto).toBe(r2(d.atual.receita.previsto - cf.total.previsto - cv.total.previsto))

    // PATCH classe_custo via rota move o Frete para fixos
    const frete = cv.por_grupo.flatMap((g) => g.itens).find((i) => i.descricao === 'Frete')
    const patch = await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos/${frete.id}`, payload: { classe_custo: 'fixo' } })
    expect(patch.json()).toMatchObject({ classe: 'fixo', classe_custo: 'fixo' })
    const d2 = (await app.inject({ method: 'GET', url: '/v1/financeiro/dre/mes?mes=2026-10' })).json()
    expect(d2.atual.custos_fixos.previsto).toBe(r2(cf.total.previsto + 50))
    expect(d2.atual.resultado).toEqual(d.atual.resultado)

    // corte em 01/10: o anterior perde o que venceu/pagou antes do corte
    await atualizarConfigFinanceiro(pool, t, { data_corte: '2026-10-01' })
    const comCorte = await calcularDreMes(pool, { tenantId: t, mes: '2026-10', hoje: HOJE })
    expect(comCorte.data_corte).toBe('2026-10-01')
    expect(comCorte.anterior.custos_fixos.previsto).toBe(0) // aluguel/energia de setembro venceram em 10–12/09
    expect(comCorte.anterior.receita).toEqual({ previsto: 1000, realizado: 1000 }) // pago em 06/10
    await atualizarConfigFinanceiro(pool, t, { data_corte: null })

    tenantDaReq = t2
    const outro = (await app.inject({ method: 'GET', url: '/v1/financeiro/dre/mes?mes=2026-10' })).json()
    expect(outro.receita.por_cliente).toEqual([])
    expect(outro.atual.custos_fixos).toEqual({ previsto: 0, realizado: 0 })
    expect(outro.custos_variaveis.por_grupo).toEqual([])
    await app.close()
  })
})
