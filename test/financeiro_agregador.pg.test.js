// Integração com Postgres real. Só roda com TEST_PG_URL (ex.: postgres://postgres@127.0.0.1:55437/db)
// num banco com o schema completo (scripts/setup_fresh_schema.js + apply_migrations.js, incluindo a 167).
import fs from 'node:fs'
import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import {
  buscarConfigFinanceiro, calcularDre, calcularFluxoCaixa, consultarLancamentos,
  desfazerImposto, listarLancamentos, pagarImposto,
} from '../src/services/financeiro-agregador.js'
import { receberTitulo } from '../src/services/receitas-comercial.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-09-30'

describe.skipIf(!url)('financeiro-agregador (Postgres real)', () => {
  let pool
  let t
  let t2
  let marcaId
  const q = (sql, params) => pool.query(sql, params)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    const sql = fs.readFileSync('migrations/167_tenants_aliquota_imposto.sql', 'utf8')
    await q(sql)
    await q(sql) // reaplicável
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-agregador') RETURNING id`)).rows[0].id
    t2 = (await q(`INSERT INTO tenants (nome) VALUES ('t-agregador-outro') RETURNING id`)).rows[0].id

    const cliente = (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, 'Cliente A', '47999999999', 'ativo') RETURNING id`, [t],
    )).rows[0].id
    marcaId = (await q(
      `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio) VALUES ($1, $2, 'Marca A', 'cliente', '2026-06-01') RETURNING id`,
      [t, cliente],
    )).rows[0].id
    await q(
      `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
         tipo_cobranca, fixo_confirmado, comissao_confirmada, origem)
       VALUES ($1, $2, '2026-06-01', 1000, 10, 'fixo_mais_comissao', true, true, 'gestao')`, [t, marcaId],
    )
    // Só agosto tem live: fixo continua sendo cobrado nos outros meses (vigência).
    await q(
      `INSERT INTO lives (tenant_id, marca_id, status, iniciado_em, encerrado_em, fat_gerado)
       VALUES ($1, $2, 'encerrada', '2026-08-10T15:00:00-03:00', '2026-08-10T17:00:00-03:00', 5000)`, [t, marcaId],
    )
    await q(
      `INSERT INTO custos_recorrentes (tenant_id, nome, grupo, valor, dia_vencimento, inicio)
       VALUES ($1, 'Aluguel', 'estrutural', 300, 10, '2026-01-01')`, [t],
    )
    await q(
      `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento)
       VALUES ($1, 'Fatura cartão', 200, 'outros', 'cartao', '2026-09-01', '2026-09-12')`, [t],
    )
    await q(`INSERT INTO apresentadoras (tenant_id, nome, fixo) VALUES ($1, 'Ana', 2000)`, [t])
    // Fixo de julho (vence 05/08) recebido em 06/08 → base do imposto de setembro.
    await receberTitulo(pool, { tenantId: t, id: `calc:${marcaId}:2026-07:fixo`, dataPagamento: '2026-08-06', hoje: HOJE })
  })

  afterAll(async () => {
    if (!pool) return
    for (const tb of ['receita_titulos', 'custos', 'custos_recorrentes', 'apresentadora_pagamentos', 'lives', 'marca_condicoes_comerciais', 'marcas', 'apresentadoras', 'clientes']) {
      await q(`DELETE FROM ${tb} WHERE tenant_id = ANY($1::uuid[])`, [[t, t2]]).catch(() => {})
    }
    await q('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {})
    await pool.end()
  })

  it('alíquota default 10 (migration 167)', async () => {
    expect(await buscarConfigFinanceiro(pool, t)).toEqual({ aliquota_imposto_pct: 10 })
  })

  it('lançamentos de setembro: fixo por vigência, custos, apresentadora e imposto sobre o recebido de agosto', async () => {
    const itens = await listarLancamentos(pool, { tenantId: t, inicio: '2026-09', fim: '2026-09', hoje: HOJE })
    const por = (origem) => itens.filter((i) => i.origem === origem)
    expect(por('marca_fixo')).toHaveLength(1) // sem live em setembro, fixo existe por vigência
    expect(por('marca_fixo')[0]).toMatchObject({ valor_previsto: 1000, data_vencimento: '2026-10-05', status: 'previsto', virtual: true })
    expect(por('marca_comissao')).toHaveLength(0)
    expect(por('recorrente')[0]).toMatchObject({ valor_previsto: 300, data_vencimento: '2026-09-10', status: 'atrasado', virtual: true })
    expect(itens.find((i) => i.grupo === 'cartao')).toMatchObject({ valor_previsto: 200, status: 'atrasado' })
    expect(por('apresentadora')).toHaveLength(1)
    expect(por('apresentadora')[0].valor_previsto).toBeGreaterThan(0)
    expect(por('imposto')).toEqual([expect.objectContaining({
      id: 'imposto:2026-09', valor_previsto: 100, base: 1000, base_tipo: 'realizado', data_vencimento: '2026-09-20', status: 'atrasado',
    })])
  })

  it('imposto projetado: outubro (M-1 corrente) e novembro (M-1 futuro) sobre o previsto por vencimento', async () => {
    const itens = await listarLancamentos(pool, { tenantId: t, inicio: '2026-10', fim: '2026-11', hoje: HOJE })
    const imp = itens.filter((i) => i.origem === 'imposto')
    // setembro vence: fixo de agosto (1000) + comissão de agosto (500)
    expect(imp.map((i) => [i.id, i.base_tipo, i.base, i.valor_previsto])).toEqual([
      ['imposto:2026-10', 'projetado', 1500, 150],
      ['imposto:2026-11', 'projetado', 1000, 100],
    ])
    expect(imp.every((i) => i.status === 'previsto')).toBe(true)
  })

  it('baixa do imposto materializa 1 linha, não duplica na lista e desfaz', async () => {
    const pago = await pagarImposto(pool, { tenantId: t, mes: '2026-09', dataPagamento: '2026-09-19', hoje: HOJE })
    expect(pago).toMatchObject({ id: 'imposto:2026-09', status: 'pago', valor_pago: 100, virtual: false, data_pagamento: '2026-09-19' })
    await pagarImposto(pool, { tenantId: t, mes: '2026-09', valorPago: 60, dataPagamento: '2026-09-19', hoje: HOJE })
    const rows = (await q(`SELECT valor, valor_pago FROM custos WHERE tenant_id = $1 AND tipo = 'imposto'`, [t])).rows
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].valor_pago)).toBe(60)
    const itens = await listarLancamentos(pool, { tenantId: t, inicio: '2026-09', fim: '2026-09', hoje: HOJE })
    expect(itens.filter((i) => String(i.descricao).startsWith('Imposto')).length).toBe(1)
    expect(itens.find((i) => i.origem === 'imposto')).toMatchObject({ status: 'atrasado', valor_pago: 60 })
    const desfeito = await desfazerImposto(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })
    expect(desfeito).toMatchObject({ virtual: true, valor_pago: 0, status: 'atrasado' })
    await expect(desfazerImposto(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('DRE jun–set: fixo em todos os meses (vigência) + comissão só em agosto', async () => {
    const dre = await calcularDre(pool, { tenantId: t, inicio: '2026-06', fim: '2026-09', hoje: HOJE })
    expect(dre.meses.map((m) => [m.mes, m.receita.previsto, m.receita.realizado])).toEqual([
      ['2026-06', 1000, 0], ['2026-07', 1000, 1000], ['2026-08', 1500, 0], ['2026-09', 1000, 0],
    ])
    const set = dre.meses[3]
    expect(set.custos.por_grupo).toMatchObject({ estrutural: { previsto: 300, realizado: 0 }, cartao: { previsto: 200, realizado: 0 } })
    expect(set.imposto).toMatchObject({ previsto: 100, aliquota: 10, base: 1000 })
    expect(set.resultado.previsto).toBe(Math.round((1000 - 500 - set.apresentadoras.previsto - 100) * 100) / 100)
  })

  it('fluxo de caixa de setembro por dia de vencimento + série anual', async () => {
    const f = await calcularFluxoCaixa(pool, { tenantId: t, mes: '2026-09', saldoInicial: 1000, hoje: HOJE })
    const linha = (k) => f.linhas.find((l) => l.chave === k)
    expect(linha('5').entradas.previsto).toBe(1500) // fixo + comissão de agosto vencem 05/09
    expect(linha('10').saidas.previsto).toBeGreaterThanOrEqual(300) // aluguel (+ apresentadora de agosto)
    expect(linha('20').saidas.previsto).toBe(100) // imposto
    expect(linha('cartao').saidas.previsto).toBe(200)
    expect(f.serie_anual.find((s) => s.mes === '2026-08')).toMatchObject({ entradas: { previsto: 1000, realizado: 1000 } })
  })

  it('tenant explícito: outro tenant não vê nada; rota GET /lancamentos responde o contrato', async () => {
    expect(await listarLancamentos(pool, { tenantId: t2, inicio: '2026-06', fim: '2026-11', hoje: HOJE })).toEqual([])
    const res = await consultarLancamentos(pool, { tenantId: t, inicio: '2026-09', fim: '2026-09', hoje: HOJE, filtros: { natureza: 'receita' } })
    expect(res.itens.every((i) => i.natureza === 'receita')).toBe(true)
    expect(res.totais.receita.previsto).toBe(1000)

    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: t, papel: 'franqueado' } })
    app.decorate('withTenant', async (_tenant, fn) => fn(pool))
    await app.register(financeiroRoutes)
    const http = await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?inicio=2026-09&fim=2026-09&status=atrasado' })
    expect(http.statusCode).toBe(200)
    expect(http.json().itens.length).toBeGreaterThan(0)
    expect(http.json().itens.every((i) => i.status === 'atrasado')).toBe(true)
    const resumo = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-09&fim=2026-09' })
    expect(resumo.statusCode).toBe(200)
    expect(resumo.json()).toMatchObject({ receita_liquida: 1000, fixo_mensal: 1000, total_custos: 500 })
    await app.close()
  })
})
