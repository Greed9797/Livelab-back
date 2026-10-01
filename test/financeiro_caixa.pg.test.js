// Integração com Postgres real: corte do financeiro, saldo de caixa e receitas avulsas.
// Só roda com TEST_PG_URL (ex.: postgres://postgres@127.0.0.1:55438/db) num banco com o
// schema completo (scripts/setup_fresh_schema.js + apply_migrations.js, incluindo 169 e 170).
import fs from 'node:fs'
import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import {
  atualizarConfigFinanceiro, buscarConfigFinanceiro, calcularCaixa, calcularDre, calcularFluxoCaixa,
  calcularImpostos, listarLancamentos,
} from '../src/services/financeiro-agregador.js'
import { criarReceitaAvulsa, listarReceitasAvulsas } from '../src/services/receitas-avulsas.js'
import { receberTitulo } from '../src/services/receitas-comercial.js'
import { materializarVirtual } from '../src/services/custos-plano.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { financeiroReceitasAvulsasRoutes } from '../src/routes/financeiro_receitas_avulsas.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-10-15'
const CORTE = '2026-10-01'

describe.skipIf(!url)('financeiro: corte, caixa e receitas avulsas (Postgres real)', () => {
  let pool
  let t
  let t2
  let marcaId
  const q = (sql, params) => pool.query(sql, params)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    for (const f of ['169_financeiro_saldo_abertura.sql', '170_receitas_avulsas.sql']) {
      const sql = fs.readFileSync(`migrations/${f}`, 'utf8')
      await q(sql)
      await q(sql) // reaplicável
    }
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-caixa') RETURNING id`)).rows[0].id
    t2 = (await q(`INSERT INTO tenants (nome) VALUES ('t-caixa-outro') RETURNING id`)).rows[0].id

    const cliente = (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, 'Cliente C', '47999999998', 'ativo') RETURNING id`, [t],
    )).rows[0].id
    marcaId = (await q(
      `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio) VALUES ($1, $2, 'Marca C', 'cliente', '2026-06-01') RETURNING id`,
      [t, cliente],
    )).rows[0].id
    await q(
      `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
         tipo_cobranca, fixo_confirmado, comissao_confirmada, origem)
       VALUES ($1, $2, '2026-06-01', 1000, 10, 'fixo_mais_comissao', true, true, 'gestao')`, [t, marcaId],
    )
    // Fixo de agosto (vence 05/09) recebido 06/09 → ANTES do corte. Fixo de setembro (vence 05/10) recebido 03/10.
    await receberTitulo(pool, { tenantId: t, id: `calc:${marcaId}:2026-08:fixo`, dataPagamento: '2026-09-06', hoje: HOJE })
    await receberTitulo(pool, { tenantId: t, id: `calc:${marcaId}:2026-09:fixo`, dataPagamento: '2026-10-03', hoje: HOJE })
    // Aluguel recorrente (dia 10): setembro vencido sem baixa (fora); outubro pago em 10/10.
    const rec = (await q(
      `INSERT INTO custos_recorrentes (tenant_id, nome, grupo, valor, dia_vencimento, inicio)
       VALUES ($1, 'Aluguel', 'estrutural', 300, 10, '2026-01-01') RETURNING id`, [t],
    )).rows[0].id
    const aluguelOut = await materializarVirtual(pool, { tenantId: t, recorrente_id: rec, mes: '2026-10' })
    await q(`UPDATE custos SET valor_pago = 300, data_pagamento = '2026-10-10' WHERE id = $1 AND tenant_id = $2`, [aluguelOut, t])
    // Custo de outubro pago ANTES do corte → fora; internet em aberto → a pagar.
    await q(
      `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento, valor_pago, data_pagamento)
       VALUES ($1, 'Pago antes', 100, 'outros', 'diversos', '2026-10-01', '2026-10-20', 100, '2026-09-29'),
              ($1, 'Internet', 150, 'outros', 'ferramentas', '2026-10-01', '2026-10-25', 0, NULL)`, [t],
    )
    // Receitas avulsas: aporte 5000 (recebido 01/10), serviço 200 (recebido 02/10), serviço 800 em aberto (vence 20/10).
    await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Aporte sócio', grupo: 'aporte', valor_previsto: 5000, data_vencimento: '2026-10-01', valor_pago: 5000, data_pagamento: '2026-10-01' }, hoje: HOJE })
    await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Consultoria A', grupo: 'servico', valor_previsto: 200, data_vencimento: '2026-10-02', valor_pago: 200, data_pagamento: '2026-10-02' }, hoje: HOJE })
    await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Consultoria B', grupo: 'servico', valor_previsto: 800, data_vencimento: '2026-10-20' }, hoje: HOJE })
  })

  afterAll(async () => {
    if (!pool) return
    for (const tb of ['receitas_avulsas', 'receita_titulos', 'custos', 'custos_recorrentes', 'marca_condicoes_comerciais', 'marcas', 'clientes']) {
      await q(`DELETE FROM ${tb} WHERE tenant_id = ANY($1::uuid[])`, [[t, t2]]).catch(() => {})
    }
    await q('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {})
    await pool.end()
  })

  it('config: default sem corte; PATCH parcial grava data_corte + saldo_abertura', async () => {
    expect(await buscarConfigFinanceiro(pool, t)).toEqual({ aliquota_imposto_pct: 10, data_corte: null, saldo_abertura: 0 })
    expect(await calcularCaixa(pool, { tenantId: t, hoje: HOJE })).toMatchObject({ configurado: false, saldo_atual: 0 })
    // Sem corte: imposto de outubro = 10% do recebido em setembro (fixo de agosto).
    const [semCorte] = await calcularImpostos(pool, { tenantId: t, inicio: '2026-10', fim: '2026-10', hoje: HOJE })
    expect(semCorte).toMatchObject({ base: 1000, valor: 100 })

    const cfg = await atualizarConfigFinanceiro(pool, t, { data_corte: CORTE, saldo_abertura: 10000 })
    expect(cfg).toEqual({ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: 10000 })
    expect(await atualizarConfigFinanceiro(pool, t, { aliquota_imposto_pct: 10 })).toEqual(cfg) // subconjunto não apaga o resto
  })

  it('imposto com corte: outubro 0; novembro projeta sobre outubro sem o aporte', async () => {
    const [out, nov] = await calcularImpostos(pool, { tenantId: t, inicio: '2026-10', fim: '2026-11', hoje: HOJE })
    expect(out).toMatchObject({ base: 0, valor: 0 })
    // vencimentos de outubro >= corte: fixo set 1000 + consultorias 200 + 800 (aporte fora)
    expect(nov).toMatchObject({ base_tipo: 'projetado', base: 2000, valor: 200 })
  })

  it('lançamentos com corte: exclui vencido sem baixa e pago antes do corte; inclui avulsas', async () => {
    const itens = await listarLancamentos(pool, { tenantId: t, inicio: '2026-09', fim: '2026-10', hoje: HOJE })
    const desc = itens.map((i) => i.descricao)
    expect(desc).not.toContain('Pago antes')
    expect(itens.filter((i) => i.descricao === 'Aluguel').map((i) => i.competencia)).toEqual(['2026-10-01'])
    expect(itens.filter((i) => i.origem === 'marca_fixo').map((i) => i.competencia)).toEqual(['2026-09-01', '2026-10-01'])
    expect(itens.filter((i) => i.origem === 'avulsa').map((i) => [i.grupo, i.status])).toEqual([
      ['aporte', 'pago'], ['servico', 'pago'], ['servico', 'pendente'],
    ])
    expect(itens.some((i) => i.origem === 'imposto')).toBe(false)
  })

  it('DRE com corte: aporte fora da receita; setembro só com o que caiu depois do corte', async () => {
    const dre = await calcularDre(pool, { tenantId: t, inicio: '2026-09', fim: '2026-10', hoje: HOJE })
    expect(dre.data_corte).toBe(CORTE)
    const [set, out] = dre.meses
    expect(set.receita).toEqual({ previsto: 1000, realizado: 1000 })
    expect(set.custos.previsto).toBe(0)
    expect(out.receita).toEqual({ previsto: 2000, realizado: 200 })
    expect(out.aportes).toEqual({ previsto: 5000, realizado: 5000 })
    expect(out.custos).toMatchObject({ previsto: 450, realizado: 300 })
    expect(out.resultado.previsto).toBe(2000 - 450 - out.apresentadoras.previsto)
  })

  it('caixa: abertura + entradas − saídas; a receber/a pagar até o fim do mês', async () => {
    const c = await calcularCaixa(pool, { tenantId: t, hoje: HOJE })
    expect(c).toMatchObject({
      configurado: true, data_corte: CORTE, saldo_abertura: 10000, ate: HOJE, fim_mes: '2026-10-31',
      entradas_realizadas: 6200, saidas_realizadas: 300, saldo_atual: 15900,
      a_receber: 800, a_pagar: 150, saldo_projetado_fim_mes: 16550,
      detalhe: { entradas: { receitas: 1000, avulsas: 200, aportes: 5000 }, saidas: { custos: 300, apresentadoras: 0, imposto: 0 } },
    })
    // Antes do aluguel ser pago: saída cai no projetado (realizado entre 'ate' e o fim do mês).
    const c5 = await calcularCaixa(pool, { tenantId: t, ate: '2026-10-05', hoje: HOJE })
    expect(c5).toMatchObject({ saldo_atual: 16200, saidas_realizadas: 0, saldo_projetado_fim_mes: 16550 })
    expect(await calcularCaixa(pool, { tenantId: t2, hoje: HOJE })).toMatchObject({ configurado: false })
  })

  it('fluxo de caixa: saldo_inicial padrão = caixa no início do mês', async () => {
    expect(await calcularFluxoCaixa(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })).toMatchObject({ saldo_inicial: 0, saldo_inicial_origem: 'caixa' })
    const out = await calcularFluxoCaixa(pool, { tenantId: t, mes: '2026-10', hoje: HOJE })
    expect(out).toMatchObject({ saldo_inicial: 10000, saldo_inicial_origem: 'caixa', data_corte: CORTE })
    expect(out.totais.entradas.realizado).toBe(6200)
    expect(out.totais.saidas.realizado).toBe(300)
    expect((await calcularFluxoCaixa(pool, { tenantId: t, mes: '2026-11', hoje: HOJE })).saldo_inicial).toBe(15900)
    expect((await calcularFluxoCaixa(pool, { tenantId: t, mes: '2026-11', saldoInicial: 5, hoje: HOJE })).saldo_inicial).toBe(5)
  })

  it('tenant explícito + RLS (USING e WITH CHECK) em receitas_avulsas', async () => {
    expect(await listarReceitasAvulsas(pool, { tenantId: t2, inicio: '2026-01', fim: '2026-12', hoje: HOJE })).toEqual([])
    const client = await pool.connect()
    try {
      await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_tester_fin') THEN CREATE ROLE rls_tester_fin NOLOGIN; END IF; END $$`)
      await client.query('GRANT SELECT, INSERT ON receitas_avulsas TO rls_tester_fin')
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE rls_tester_fin')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [t2])
      expect((await client.query('SELECT count(*)::int AS n FROM receitas_avulsas')).rows[0].n).toBe(0)
      await expect(client.query(
        `INSERT INTO receitas_avulsas (tenant_id, descricao, valor_previsto, data_vencimento, competencia) VALUES ($1, 'x', 1, '2026-10-01', '2026-10-01')`, [t],
      )).rejects.toThrow(/row-level security/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('HTTP: CRUD de receitas avulsas, /lancamentos, /config e /caixa', async () => {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: t, papel: 'franqueado', sub: null } })
    app.decorate('withTenant', async (_tenant, fn) => fn(pool))
    await app.register(financeiroRoutes)
    await app.register(financeiroReceitasAvulsasRoutes)

    const cfg = await app.inject({ method: 'GET', url: '/v1/financeiro/config' })
    expect(cfg.json()).toEqual({ aliquota_imposto_pct: 10, data_corte: CORTE, saldo_abertura: 10000 })

    const criado = await app.inject({
      method: 'POST', url: '/v1/financeiro/receitas-avulsas',
      payload: { descricao: 'Reembolso frete', grupo: 'reembolso', valor_previsto: '120,50', data_vencimento: '2026-10-28' },
    })
    expect(criado.statusCode).toBe(201)
    const id = criado.json().id
    expect(criado.json()).toMatchObject({ valor_previsto: 120.5, competencia: '2026-10-01', status: 'pendente' })

    const editado = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas-avulsas/${id}`, payload: { valor_previsto: 130 } })
    expect(editado.json()).toMatchObject({ valor_previsto: 130 })
    const recebido = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas-avulsas/${id}/receber`, payload: { data_pagamento: '2026-10-14' } })
    expect(recebido.json()).toMatchObject({ valor_pago: 130, data_pagamento: '2026-10-14', status: 'pago' })

    const lanc = await app.inject({ method: 'GET', url: '/v1/financeiro/lancamentos?inicio=2026-10&fim=2026-10&natureza=receita' })
    expect(lanc.json().itens.find((i) => i.id === id)).toMatchObject({ origem: 'avulsa', grupo: 'reembolso', status: 'pago' })
    expect(lanc.json().totais.aportes).toEqual({ previsto: 5000, pago: 5000 })

    const caixa = await app.inject({ method: 'GET', url: '/v1/financeiro/caixa?ate=2026-10-15' })
    expect(caixa.json()).toMatchObject({ saldo_atual: 16030, entradas_realizadas: 6330 })

    const desfeito = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas-avulsas/${id}/desfazer` })
    expect(desfeito.json()).toMatchObject({ valor_pago: 0, data_pagamento: null, status: 'pendente' })
    expect((await app.inject({ method: 'DELETE', url: `/v1/financeiro/receitas-avulsas/${id}` })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `/v1/financeiro/receitas-avulsas/${id}` })).statusCode).toBe(404)

    const fluxo = await app.inject({ method: 'GET', url: '/v1/financeiro/fluxo-caixa?mes=2026-11' })
    expect(fluxo.json()).toMatchObject({ saldo_inicial: 15900, saldo_inicial_origem: 'caixa' })
    await app.close()
  })
})
