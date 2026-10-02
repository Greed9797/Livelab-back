// Integração com Postgres real (frente B1 — migration 173). Só roda com TEST_PG_URL
// (ex.: postgres://postgres@127.0.0.1:55481/db) num banco com o schema completo
// (001-015 manuais + apply_migrations.js). Valida a migration 173 reaplicável e o ciclo
// perder → desperder → receber (títulos do comercial, avulsas) e cancelar → reativar → pagar (custos).
import fs from 'node:fs'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import {
  desperderTitulo, gerarTitulosReceita, listarTitulosReceita, perderTitulo, receberTitulo, totalizarTitulos,
} from '../src/services/receitas-comercial.js'
import {
  criarReceitaAvulsa, desperderReceitaAvulsa, perderReceitaAvulsa, receberReceitaAvulsa,
} from '../src/services/receitas-avulsas.js'
import {
  cancelarCusto, custoParaItem, gerarCustosDoMes, listarCustos, materializarVirtual, reativarCusto,
} from '../src/services/custos-plano.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-09-15'

describe.skipIf(!url)('perdas e cancelamentos (Postgres real)', () => {
  let pool
  let t
  let t2
  let userId
  let marcaId
  const q = (sql, params) => pool.query(sql, params)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    const sql = fs.readFileSync('migrations/173_perdas_cancelamentos.sql', 'utf8')
    await q(sql)
    await q(sql)
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-perdas') RETURNING id`)).rows[0].id
    t2 = (await q(`INSERT INTO tenants (nome) VALUES ('t-perdas-outro') RETURNING id`)).rows[0].id
    userId = (await q(
      `INSERT INTO users (tenant_id, nome, email, senha_hash, papel) VALUES ($1, 'Fin', 'fin-perdas@x.test', 'x', 'financeiro') RETURNING id`,
      [t],
    )).rows[0].id
    const cliente = (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, 'Cliente P', '47999999999', 'ativo') RETURNING id`, [t],
    )).rows[0].id
    marcaId = (await q(
      `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio) VALUES ($1, $2, 'Perdas', 'cliente', '2026-01-01') RETURNING id`,
      [t, cliente],
    )).rows[0].id
    await q(
      `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
         tipo_cobranca, fixo_confirmado, comissao_confirmada, origem,
         fixo_vencimento_dia, fixo_vencimento_mes_offset, comissao_vencimento_dia, comissao_vencimento_mes_offset)
       VALUES ($1, $2, '2026-01-01', 1000, 0, 'fixo_mais_comissao', true, true, 'gestao', 10, 0, 10, 0)`,
      [t, marcaId],
    )
  })

  afterAll(async () => {
    if (!pool) return
    for (const tenant of [t, t2].filter(Boolean)) {
      await q('DELETE FROM receita_titulos WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM receitas_avulsas WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM custos WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM custos_recorrentes WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM marca_condicoes_comerciais WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM marcas WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM clientes WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM users WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM tenants WHERE id = $1', [tenant])
    }
    await pool.end()
  })

  it('migration 173 cria as colunas (nullable), FKs e CHECK de 300 caracteres', async () => {
    const cols = (await q(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE (table_name IN ('receita_titulos', 'receitas_avulsas') AND column_name LIKE 'perdido_%')
           OR (table_name = 'custos' AND column_name LIKE 'cancelado_%')
        ORDER BY 1, 2`,
    )).rows.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}`)
    expect(cols).toEqual([
      'custos.cancelado_em:timestamp with time zone:YES',
      'custos.cancelado_motivo:text:YES',
      'custos.cancelado_por:uuid:YES',
      'receita_titulos.perdido_em:timestamp with time zone:YES',
      'receita_titulos.perdido_motivo:text:YES',
      'receita_titulos.perdido_por:uuid:YES',
      'receitas_avulsas.perdido_em:timestamp with time zone:YES',
      'receitas_avulsas.perdido_motivo:text:YES',
      'receitas_avulsas.perdido_por:uuid:YES',
    ])
    const cons = (await q(
      `SELECT conname FROM pg_constraint WHERE conname IN
         ('receita_titulos_perdido_motivo_check', 'receitas_avulsas_perdido_motivo_check', 'custos_cancelado_motivo_check')
       ORDER BY 1`,
    )).rows.map((r) => r.conname)
    expect(cons).toHaveLength(3)
    const fks = (await q(
      `SELECT count(*)::int AS n FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND c.confdeltype = 'n'
          AND c.conrelid IN ('receita_titulos'::regclass, 'receitas_avulsas'::regclass, 'custos'::regclass)
          AND a.attname IN ('perdido_por', 'cancelado_por')`,
    )).rows[0].n
    expect(fks).toBe(3)
    const longo = 'x'.repeat(301)
    await expect(q(
      `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento, cancelado_em, cancelado_motivo)
       VALUES ($1, 'x', 1, 'outros', 'diversos', '2026-09-01', '2026-09-10', NOW(), $2)`,
      [t, longo],
    )).rejects.toThrow(/custos_cancelado_motivo_check/)
  })

  it('título do comercial: perder (calc:) → receber 409 → gerar preserva → desperder → receber', async () => {
    const vid = `calc:${marcaId}:2026-09:fixo`
    const { item: perdido, ja_perdido: ja } = await perderTitulo(pool, { tenantId: t, id: vid, motivo: 'Fechou a loja', actorUserId: userId, hoje: HOJE })
    expect(ja).toBe(false)
    expect(perdido).toMatchObject({ status: 'perdido', materializado: true, perdido_motivo: 'Fechou a loja', perdido_por: userId, valor_previsto: 1000 })
    expect(perdido.perdido_em).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // idempotente: segunda perda não troca data nem autor
    const again = await perderTitulo(pool, { tenantId: t, id: perdido.id, hoje: HOJE })
    expect(again).toMatchObject({ ja_perdido: true, item: { perdido_em: perdido.perdido_em, perdido_motivo: 'Fechou a loja' } })

    // receber perdido → 409, nada gravado
    await expect(receberTitulo(pool, { tenantId: t, id: perdido.id, hoje: HOJE })).rejects.toMatchObject({ statusCode: 409, code: 'RECEITA_PERDIDA' })
    await expect(receberTitulo(pool, { tenantId: t, id: vid, hoje: HOJE })).rejects.toMatchObject({ statusCode: 409 })
    expect((await q('SELECT valor_pago FROM receita_titulos WHERE id = $1', [perdido.id])).rows[0].valor_pago).toBe('0.00')

    // listagem e totais: previsto mantém; em_aberto exclui; perdido = saldo
    const lista = await listarTitulosReceita(pool, { tenantId: t, inicio: '2026-09', fim: '2026-09', hoje: HOJE })
    expect(lista).toHaveLength(1)
    expect(totalizarTitulos(lista)).toMatchObject({ valor_previsto: 1000, em_aberto: 0, perdido: 1000 })
    expect(await listarTitulosReceita(pool, { tenantId: t, inicio: '2026-09', fim: '2026-09', hoje: HOJE, status: 'perdido' })).toHaveLength(1)

    // comercial muda o fixo: gerar NÃO atualiza nem apaga o perdido
    await q(`UPDATE marca_condicoes_comerciais SET fixo_mensal = 1500 WHERE tenant_id = $1 AND marca_id = $2`, [t, marcaId])
    const g = await gerarTitulosReceita(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })
    expect(g).toMatchObject({ criados: 0, atualizados: 0, removidos: 0, perdidos_preservados: 1 })
    expect(g.itens[0]).toMatchObject({ id: perdido.id, valor_previsto: 1000, valor_calculado: 1500, status: 'perdido' })
    // comercial deixa de gerar o título: gerar NÃO apaga o perdido
    await q(`UPDATE marca_condicoes_comerciais SET fixo_mensal = 0 WHERE tenant_id = $1 AND marca_id = $2`, [t, marcaId])
    const g2 = await gerarTitulosReceita(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })
    expect(g2.removidos).toBe(0)
    expect((await q('SELECT count(*)::int AS n FROM receita_titulos WHERE id = $1', [perdido.id])).rows[0].n).toBe(1)
    await q(`UPDATE marca_condicoes_comerciais SET fixo_mensal = 1000 WHERE tenant_id = $1 AND marca_id = $2`, [t, marcaId])

    // outro tenant não enxerga/perde
    await expect(perderTitulo(pool, { tenantId: t2, id: perdido.id, hoje: HOJE })).rejects.toMatchObject({ statusCode: 404 })

    // desperder → volta derivado; receber parcial; perder parcial preserva valor_pago
    const { item: volta, estava_perdido: estava } = await desperderTitulo(pool, { tenantId: t, id: perdido.id, hoje: HOJE })
    expect(estava).toBe(true)
    expect(volta).toMatchObject({ status: 'atrasado', perdido_em: null, perdido_motivo: null, perdido_por: null })
    // gerar volta a acompanhar o comercial depois de desfeita a perda
    await q(`UPDATE marca_condicoes_comerciais SET fixo_mensal = 1200 WHERE tenant_id = $1 AND marca_id = $2`, [t, marcaId])
    const g3 = await gerarTitulosReceita(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })
    expect(g3).toMatchObject({ atualizados: 1, perdidos_preservados: 0 })
    expect(g3.itens[0]).toMatchObject({ valor_previsto: 1200 })

    const parcial = await receberTitulo(pool, { tenantId: t, id: perdido.id, valorPago: 400, dataPagamento: '2026-09-12', hoje: HOJE })
    expect(parcial).toMatchObject({ status: 'atrasado', valor_pago: 400 }) // parcial vencido
    const { item: perdaParcial } = await perderTitulo(pool, { tenantId: t, id: perdido.id, hoje: HOJE })
    expect(perdaParcial).toMatchObject({ status: 'perdido', valor_pago: 400, data_pagamento: '2026-09-12', perdido_motivo: null })
    const tot = totalizarTitulos(await listarTitulosReceita(pool, { tenantId: t, inicio: '2026-09', fim: '2026-09', hoje: HOJE }))
    expect(tot).toMatchObject({ valor_previsto: 1200, valor_pago: 400, em_aberto: 0, perdido: 800 })

    await desperderTitulo(pool, { tenantId: t, id: perdido.id, hoje: HOJE })
    const pago = await receberTitulo(pool, { tenantId: t, id: perdido.id, valorPago: 1200, dataPagamento: '2026-09-14', hoje: HOJE })
    expect(pago.status).toBe('pago')
    await expect(perderTitulo(pool, { tenantId: t, id: perdido.id, hoje: HOJE })).rejects.toMatchObject({ statusCode: 409, code: 'RECEITA_PAGA' })
  })

  it('receita avulsa: perder → receber 409 → desperder → receber', async () => {
    const av = await criarReceitaAvulsa(pool, {
      tenantId: t, dados: { descricao: 'Consultoria', grupo: 'servico', valor_previsto: 500, data_vencimento: '2026-09-10' }, hoje: HOJE,
    })
    const p = await perderReceitaAvulsa(pool, { tenantId: t, id: av.id, motivo: 'desistiu', actorUserId: userId, hoje: HOJE })
    expect(p).toMatchObject({ ja_perdido: false, item: { status: 'perdido', perdido_motivo: 'desistiu', perdido_por: userId } })
    expect(await perderReceitaAvulsa(pool, { tenantId: t2, id: av.id, hoje: HOJE })).toBeNull()
    await expect(receberReceitaAvulsa(pool, { tenantId: t, id: av.id, hoje: HOJE })).rejects.toMatchObject({ statusCode: 409 })
    const d = await desperderReceitaAvulsa(pool, { tenantId: t, id: av.id, hoje: HOJE })
    expect(d).toMatchObject({ estava_perdido: true, item: { status: 'atrasado', perdido_em: null } })
    const r = await receberReceitaAvulsa(pool, { tenantId: t, id: av.id, hoje: HOJE })
    expect(r).toMatchObject({ status: 'pago', valor_pago: 500 })
    await expect(perderReceitaAvulsa(pool, { tenantId: t, id: av.id, hoje: HOJE })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('custo recorrente: cancela só o mês (rec:), gerar não recria, reativar e pagar', async () => {
    const recId = (await q(
      `INSERT INTO custos_recorrentes (tenant_id, nome, grupo, valor, dia_vencimento, inicio) VALUES ($1, 'Aluguel', 'estrutural', 3000, 10, '2026-01-01') RETURNING id`,
      [t],
    )).rows[0].id
    const id = await materializarVirtual(pool, { tenantId: t, recorrente_id: recId, mes: '2026-09' })
    const c = await cancelarCusto(pool, { tenantId: t, id, motivo: 'perdoado', actorUserId: userId })
    expect(custoParaItem(c.row, HOJE)).toMatchObject({ status: 'cancelado', cancelado_motivo: 'perdoado', cancelado_por: userId, origem: 'recorrente' })
    const g = await gerarCustosDoMes(pool, { tenantId: t, mes: '2026-09' })
    expect(g.criados).toBe(0)
    const itens = await listarCustos(pool, { tenantId: t, inicio: '2026-09', fim: '2026-10', hoje: HOJE })
    expect(itens.map((i) => [i.competencia, i.status, i.virtual])).toEqual([
      ['2026-09-01', 'cancelado', false], ['2026-10-01', 'previsto', true],
    ])
    expect(await cancelarCusto(pool, { tenantId: t2, id })).toBeNull()
    const r = await reativarCusto(pool, { tenantId: t, id })
    expect(r.estava_cancelado).toBe(true)
    expect(custoParaItem(r.row, HOJE)).toMatchObject({ status: 'atrasado', cancelado_em: null })
    await q(`UPDATE custos SET valor_pago = valor, data_pagamento = '2026-09-10' WHERE id = $1`, [id])
    await expect(cancelarCusto(pool, { tenantId: t, id })).rejects.toMatchObject({ statusCode: 409, code: 'CUSTO_PAGO' })
  })
})
