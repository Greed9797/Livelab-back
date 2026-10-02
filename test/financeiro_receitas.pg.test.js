// Integração com Postgres real. Só roda com TEST_PG_URL (ex.: postgres://postgres@127.0.0.1:55432/db)
// num banco com o schema completo (001-015 manuais + apply_migrations.js, incluindo a 165).
import fs from 'node:fs'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import {
  calcularReceitasComerciais,
  desfazerRecebimento,
  gerarTitulosReceita,
  listarTitulosReceita,
  receberTitulo,
} from '../src/services/receitas-comercial.js'
import { atualizarVencimentoCondicao, confirmarCondicaoMarca } from '../src/services/marca-condicoes.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-09-30'

describe.skipIf(!url)('receitas do comercial (Postgres real)', () => {
  let pool
  let t
  let t2
  const ids = {}

  const q = (sql, params) => pool.query(sql, params)
  const marca = async (tenant, nome, extra = {}) => {
    const cliente = (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, $2, '47999999999', 'ativo') RETURNING id`,
      [tenant, `Cliente ${nome}`],
    )).rows[0].id
    const row = (await q(
      `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio, data_fim, criado_em)
       VALUES ($1, $2, $3, 'cliente', $4, $5, COALESCE($6::timestamptz, NOW())) RETURNING id`,
      [tenant, cliente, nome, extra.data_inicio ?? null, extra.data_fim ?? null, extra.criado_em ?? null],
    )).rows[0]
    return { id: row.id, cliente }
  }
  const condicao = (tenant, marcaId, inicio, c) => q(
    `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
       tipo_cobranca, fixo_confirmado, comissao_confirmada, origem,
       fixo_vencimento_dia, fixo_vencimento_mes_offset, comissao_vencimento_dia, comissao_vencimento_mes_offset)
     VALUES ($1,$2,$3,$4,$5,$6,true,true,'gestao',
       COALESCE($7::smallint,5),COALESCE($8::smallint,1),COALESCE($9::smallint,5),COALESCE($10::smallint,1)) RETURNING id`,
    [tenant, marcaId, inicio, c.fixo, c.pct, c.tipo ?? 'fixo_mais_comissao', c.fd ?? null, c.fo ?? null, c.cd ?? null, c.co ?? null],
  ).then((r) => r.rows[0].id)
  const live = (tenant, marcaId, iniciadoEm, gmv) => q(
    `INSERT INTO lives (tenant_id, marca_id, status, iniciado_em, encerrado_em, fat_gerado)
     VALUES ($1, $2, 'encerrada', $3::timestamptz, $3::timestamptz + interval '2 hours', $4)`,
    [tenant, marcaId, iniciadoEm, gmv],
  )

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    // Migration 165 é reaplicável.
    const sql = fs.readFileSync('migrations/165_receita_titulos_vencimento_condicoes.sql', 'utf8')
    await q(sql)
    await q(sql)
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-receitas') RETURNING id`)).rows[0].id
    t2 = (await q(`INSERT INTO tenants (nome) VALUES ('t-receitas-outro') RETURNING id`)).rows[0].id

    // M1: GMV + % — contrato desde 16/07, fixo 3100 + 10%; fixo vence dia 31 do mês seguinte,
    // comissão dia 10 do próprio mês. Em 09/2026 nova versão: fixo 2000 OU 5%.
    const m1 = await marca(t, 'Alfa', { data_inicio: '2026-07-16' })
    ids.m1 = m1.id
    ids.m1c1 = await condicao(t, m1.id, '2026-07-01', { fixo: 3100, pct: 10, fd: 31, fo: 1, cd: 10, co: 0 })
    ids.m1c2 = await condicao(t, m1.id, '2026-09-01', { fixo: 2000, pct: 5, tipo: 'fixo_ou_comissao' })
    await live(t, m1.id, '2026-08-10T15:00:00-03:00', 10000)
    await live(t, m1.id, '2026-09-05T15:00:00-03:00', 50000)
    // M2: só % — sem fixo; comissão de vídeo (vendas_atribuidas) em 08.
    const m2 = await marca(t, 'Beta', { data_inicio: '2026-01-01' })
    ids.m2 = m2.id
    await condicao(t, m2.id, '2026-01-01', { fixo: 0, pct: 8 })
    await q(
      `INSERT INTO vendas_atribuidas (tenant_id, origem, origem_id, marca_id, data, gmv, status_aprovacao)
       VALUES ($1, 'video', gen_random_uuid(), $2, '2026-08-20', 5000, 'aprovada'),
              ($1, 'video', gen_random_uuid(), $2, '2026-08-21', 9999, 'reprovada')`,
      [t, m2.id],
    )
    // M3: só fixo — contrato termina 15/08 (rateio 15/31).
    const m3 = await marca(t, 'Gama', { data_inicio: '2026-01-01', data_fim: '2026-08-15' })
    ids.m3 = m3.id
    await condicao(t, m3.id, '2026-01-01', { fixo: 1000, pct: 0 })
    await live(t, m3.id, '2026-08-03T15:00:00-03:00', 7000)
    // M5: legado só com baseline 1900 e sem data_inicio → vigência a partir do cadastro (09/2026).
    const m5 = await marca(t, 'Delta', { criado_em: '2026-09-10T12:00:00-03:00' })
    ids.m5 = m5.id
    await q(
      `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, origem)
       VALUES ($1, $2, '1900-01-01', 700, 'legado_nao_verificado')`,
      [t, m5.id],
    )
    // Outro tenant: nunca aparece.
    const mx = await marca(t2, 'Alfa')
    await condicao(t2, mx.id, '2026-01-01', { fixo: 999, pct: 50 })
    await live(t2, mx.id, '2026-08-10T15:00:00-03:00', 10000)
  })

  afterAll(async () => {
    if (!pool) return
    for (const tenant of [t, t2].filter(Boolean)) {
      await q('DELETE FROM receita_titulos WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM vendas_atribuidas WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM lives WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM audit_log WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM marca_condicoes_comerciais WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM marcas WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM clientes WHERE tenant_id = $1', [tenant])
      await q('DELETE FROM tenants WHERE id = $1', [tenant])
    }
    await pool.end()
  })

  it('calcula fixo por vigência com rateio, modalidades e vencimentos do comercial', async () => {
    const itens = await calcularReceitasComerciais(pool, { tenantId: t, inicio: '2026-07', fim: '2026-10' })
    const pick = (marcaId, comp, componente) => itens.find((i) => i.marca_id === marcaId && i.competencia === comp && i.componente === componente)

    // M1 fixo: 07 rateado 16/31 (entrou 16/07), 08 cheio, 09/10 nova versão (2000) mesmo sem atividade em 10.
    expect(pick(ids.m1, '2026-07-01', 'fixo')).toMatchObject({ valor: 1600, data_vencimento: '2026-08-31' })
    // dia 31 em setembro → último dia (30)
    expect(pick(ids.m1, '2026-08-01', 'fixo')).toMatchObject({ valor: 3100, data_vencimento: '2026-09-30' })
    expect(pick(ids.m1, '2026-08-01', 'comissao')).toMatchObject({ valor: 1000, data_vencimento: '2026-08-10' })
    // 09: fixo_ou_comissao → fixo 2000 + excedente 500 (5% de 50k = 2500). Vencimento herdado do padrão (dia 5, mês seguinte).
    expect(pick(ids.m1, '2026-09-01', 'fixo')).toMatchObject({ valor: 2000, tipo_cobranca: 'fixo_ou_comissao', data_vencimento: '2026-10-05' })
    expect(pick(ids.m1, '2026-09-01', 'comissao')).toMatchObject({ valor: 500, memoria: { comissao_bruta: 2500, fixo_comparado: 2000 } })
    expect(pick(ids.m1, '2026-10-01', 'fixo')).toMatchObject({ valor: 2000, data_vencimento: '2026-11-05' })
    expect(pick(ids.m1, '2026-10-01', 'comissao')).toBeUndefined()

    // M2 só %: nenhum fixo; comissão de vídeo sem a venda reprovada.
    expect(itens.filter((i) => i.marca_id === ids.m2 && i.componente === 'fixo')).toEqual([])
    expect(pick(ids.m2, '2026-08-01', 'comissao')).toMatchObject({ valor: 400, cliente_id: expect.any(String) })

    // M3 só fixo: 07 cheio, 08 rateado 15/31, nada depois do fim; comissão 0 não vira título.
    expect(pick(ids.m3, '2026-07-01', 'fixo').valor).toBe(1000)
    expect(pick(ids.m3, '2026-08-01', 'fixo').valor).toBe(483.87)
    expect(pick(ids.m3, '2026-09-01', 'fixo')).toBeUndefined()
    expect(itens.filter((i) => i.marca_id === ids.m3 && i.componente === 'comissao')).toEqual([])

    // M5 legado: vigência a partir do mês de cadastro.
    expect(pick(ids.m5, '2026-08-01', 'fixo')).toBeUndefined()
    expect(pick(ids.m5, '2026-09-01', 'fixo').valor).toBe(700)

    // Nada de outro tenant.
    expect(itens.every((i) => [ids.m1, ids.m2, ids.m3, ids.m5].includes(i.marca_id))).toBe(true)
  })

  it('marca afiliada / própria / parceira / sistema com % > 0 não vira receita (só o GMV operacional)', async () => {
    const t3 = (await q(`INSERT INTO tenants (nome) VALUES ('t-receitas-nao-cliente') RETURNING id`)).rows[0].id
    try {
      const naoCliente = async (nome, tipo, sistema = false) => {
        const id = (await q(
          `INSERT INTO marcas (tenant_id, nome, tipo, sistema, data_inicio) VALUES ($1, $2, $3, $4, '2026-01-01') RETURNING id`,
          [t3, nome, tipo, sistema],
        )).rows[0].id
        // condição com fixo e % (ex.: % preenchido como 100 numa marca da casa)
        await condicao(t3, id, '2026-01-01', { fixo: 500, pct: 100 })
        await live(t3, id, '2026-08-10T15:00:00-03:00', 80000)
        await q(
          `INSERT INTO vendas_atribuidas (tenant_id, origem, origem_id, marca_id, data, gmv, comissao_franquia, status_aprovacao)
           VALUES ($1, 'video', gen_random_uuid(), $2, '2026-08-20', 3000, 3000, 'aprovada')`,
          [t3, id],
        )
        return id
      }
      const afiliada = await naoCliente('Afiliada X', 'afiliada')
      const propria = await naoCliente('Própria X', 'propria')
      const parceira = await naoCliente('Parceira X', 'parceira')
      const sistema = await naoCliente('Livelab Sistema X', 'propria', true)
      // controle: marca de cliente no mesmo tenant continua gerando fixo + comissão
      const cli = await marca(t3, 'Cliente Ok', { data_inicio: '2026-01-01' })
      await condicao(t3, cli.id, '2026-01-01', { fixo: 1000, pct: 10 })
      await live(t3, cli.id, '2026-08-11T15:00:00-03:00', 20000)

      const itens = await calcularReceitasComerciais(pool, { tenantId: t3, inicio: '2026-08', fim: '2026-08' })
      for (const id of [afiliada, propria, parceira, sistema]) {
        expect(itens.filter((i) => i.marca_id === id)).toEqual([])
      }
      expect(itens.filter((i) => i.marca_id === cli.id).map((i) => [i.componente, i.valor]).sort())
        .toEqual([['comissao', 2000], ['fixo', 1000]])

      const titulos = await listarTitulosReceita(pool, { tenantId: t3, inicio: '2026-08', fim: '2026-08', hoje: HOJE })
      expect(titulos.every((i) => i.marca_id === cli.id && i.marca_tipo === 'cliente')).toBe(true)

      // título materializado ANTES do filtro (marca própria): gerar remove o que não tem baixa
      await q(
        `INSERT INTO receita_titulos (tenant_id, marca_id, competencia, componente, valor_previsto, data_vencimento)
         VALUES ($1, $2, '2026-08-01', 'comissao', 83000, '2026-09-05')`,
        [t3, propria],
      )
      const antes = await listarTitulosReceita(pool, { tenantId: t3, inicio: '2026-08', fim: '2026-08', hoje: HOJE })
      expect(antes.find((i) => i.marca_id === propria)).toMatchObject({ marca_tipo: 'propria', valor_calculado: 0, divergente: true })
      const g = await gerarTitulosReceita(pool, { tenantId: t3, mes: '2026-08', hoje: HOJE })
      expect(g.removidos).toBe(1)
      expect(g.itens.some((i) => i.marca_id === propria)).toBe(false)
    } finally {
      for (const tabela of ['receita_titulos', 'vendas_atribuidas', 'lives', 'audit_log', 'marca_condicoes_comerciais', 'marcas', 'clientes']) {
        await q(`DELETE FROM ${tabela} WHERE tenant_id = $1`, [t3])
      }
      await q('DELETE FROM tenants WHERE id = $1', [t3])
    }
  })

  it('modo legado (atividade) só cobra fixo em mês com GMV', async () => {
    const itens = await calcularReceitasComerciais(pool, { tenantId: t, inicio: '2026-07', fim: '2026-10', fixo: 'atividade' })
    const fixosM1 = itens.filter((i) => i.marca_id === ids.m1 && i.componente === 'fixo').map((i) => i.competencia)
    expect(fixosM1).toEqual(['2026-08-01', '2026-09-01'])
  })

  it('lista, gera, recebe (virtual e parcial) e desfaz com status derivado', async () => {
    let lista = await listarTitulosReceita(pool, { tenantId: t, inicio: '2026-07', fim: '2026-08', hoje: HOJE })
    const julho = lista.find((i) => i.marca_id === ids.m1 && i.competencia === '2026-07-01')
    expect(julho).toMatchObject({ natureza: 'receita', origem: 'comercial', materializado: false, status: 'atrasado' }) // venceu 31/08
    expect(julho.id).toBe(`calc:${ids.m1}:2026-07:fixo`)
    const comissaoAgo = lista.find((i) => i.marca_id === ids.m1 && i.competencia === '2026-08-01' && i.componente === 'comissao')
    expect(comissaoAgo.status).toBe('atrasado') // venceu 10/08
    const fixoAgoCalc = lista.find((i) => i.marca_id === ids.m1 && i.competencia === '2026-08-01' && i.componente === 'fixo')
    expect(fixoAgoCalc.status).toBe('pendente') // vence 30/09 = hoje
    const set = await listarTitulosReceita(pool, { tenantId: t, inicio: '2026-10', fim: '2026-10', hoje: HOJE })
    expect(set.find((i) => i.marca_id === ids.m1).status).toBe('previsto') // vence 05/11

    const g1 = await gerarTitulosReceita(pool, { tenantId: t, mes: '2026-08', hoje: HOJE })
    expect(g1.criados).toBe(4) // m1 fixo+comissão, m2 comissão, m3 fixo
    const g2 = await gerarTitulosReceita(pool, { tenantId: t, mes: '2026-08', hoje: HOJE })
    expect(g2).toMatchObject({ criados: 0, atualizados: 4, removidos: 0 })

    // Baixa parcial num título materializado.
    const fixoAgo = g2.itens.find((i) => i.marca_id === ids.m1 && i.componente === 'fixo')
    const parcial = await receberTitulo(pool, { tenantId: t, id: fixoAgo.id, valorPago: 1000, dataPagamento: '2026-09-29', hoje: HOJE })
    expect(parcial).toMatchObject({ valor_pago: 1000, data_pagamento: '2026-09-29', status: 'parcial' })
    const total = await receberTitulo(pool, { tenantId: t, id: fixoAgo.id, hoje: HOJE })
    expect(total).toMatchObject({ valor_pago: 3100, data_pagamento: HOJE, status: 'pago' })

    // Baixa num título virtual materializa e baixa.
    const pagoJulho = await receberTitulo(pool, { tenantId: t, id: julho.id, hoje: HOJE })
    expect(pagoJulho).toMatchObject({ materializado: true, valor_pago: 1600, status: 'pago' })
    await expect(receberTitulo(pool, { tenantId: t2, id: pagoJulho.id, hoje: HOJE })).rejects.toMatchObject({ statusCode: 404 })

    const desfeito = await desfazerRecebimento(pool, { tenantId: t, id: pagoJulho.id, hoje: HOJE })
    expect(desfeito).toMatchObject({ valor_pago: 0, data_pagamento: null, status: 'atrasado' })

    lista = await listarTitulosReceita(pool, { tenantId: t, inicio: '2026-07', fim: '2026-08', hoje: HOJE, status: 'pago' })
    expect(lista.map((i) => i.id)).toEqual([fixoAgo.id])
  })

  it('gerar remove título sem baixa que o comercial deixou de gerar', async () => {
    await q(`UPDATE marcas SET data_fim = '2026-07-31' WHERE id = $1`, [ids.m3])
    const g = await gerarTitulosReceita(pool, { tenantId: t, mes: '2026-08', hoje: HOJE })
    expect(g.removidos).toBe(1)
    expect(g.itens.some((i) => i.marca_id === ids.m3)).toBe(false)
    await q(`UPDATE marcas SET data_fim = '2026-08-15' WHERE id = $1`, [ids.m3])
  })

  it('ajuste de vencimento no comercial move títulos em aberto e preserva os baixados', async () => {
    await gerarTitulosReceita(pool, { tenantId: t, mes: '2026-07', hoje: HOJE })
    const client = await pool.connect()
    try {
      const cond = await atualizarVencimentoCondicao(client, {
        tenantId: t, marcaId: ids.m1, condicaoId: ids.m1c1,
        vencimento: { fixo_vencimento_dia: 20, fixo_vencimento_mes_offset: 0 },
      })
      expect(cond).toMatchObject({ fixo_vencimento_dia: 20, fixo_vencimento_mes_offset: 0, comissao_vencimento_dia: 10 })
    } finally {
      client.release()
    }
    const rows = (await q(
      `SELECT competencia, componente, data_vencimento, valor_pago FROM receita_titulos
        WHERE tenant_id = $1 AND marca_id = $2 AND componente = 'fixo' ORDER BY competencia`,
      [t, ids.m1],
    )).rows
    // 07 em aberto → dia 20 do próprio mês; 08 já pago → mantém 30/09.
    expect(rows.map((r) => [r.competencia, r.data_vencimento])).toEqual([
      ['2026-07-01', '2026-07-20'],
      ['2026-08-01', '2026-09-30'],
    ])
  })

  it('nova versão da condição herda o vencimento da anterior quando omitido', async () => {
    const client = await pool.connect()
    try {
      const rev = (await client.query(
        `SELECT COALESCE(MAX(revision), 1) AS r FROM marca_condicoes_comerciais WHERE tenant_id = $1 AND marca_id = $2 AND cancelled_at IS NULL`,
        [t, ids.m2],
      )).rows[0].r
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [t])
      await client.query(`UPDATE marca_condicoes_comerciais SET comissao_vencimento_dia = 15, comissao_vencimento_mes_offset = 0 WHERE marca_id = $1`, [ids.m2])
      const r = await confirmarCondicaoMarca(client, {
        tenantId: t, marcaId: ids.m2, expectedRevision: rev, idempotencyKey: `pg-${Date.now()}`,
        proposta: { inicio_vigencia: '2026-11', fixo_mensal: 0, comissao_franquia_pct: 9, comissao_franqueadora_pct: 0, fixo_vencimento_dia: 31 },
      })
      expect(r.condition).toMatchObject({ fixo_vencimento_dia: 31, fixo_vencimento_mes_offset: 1, comissao_vencimento_dia: 15, comissao_vencimento_mes_offset: 0 })
    } finally {
      client.release()
    }
  })

  it('RLS isola receita_titulos por tenant (USING e WITH CHECK)', async () => {
    const client = await pool.connect()
    try {
      await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receitas_rls_test') THEN CREATE ROLE receitas_rls_test NOSUPERUSER NOBYPASSRLS; END IF; END $$`)
      await client.query('GRANT SELECT, INSERT ON receita_titulos TO receitas_rls_test')
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE receitas_rls_test')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [t2])
      expect((await client.query('SELECT count(*)::int AS n FROM receita_titulos')).rows[0].n).toBe(0)
      await expect(client.query(
        `INSERT INTO receita_titulos (tenant_id, marca_id, competencia, componente, valor_previsto, data_vencimento)
         VALUES ($1, $2, '2026-12-01', 'fixo', 1, '2027-01-05')`,
        [t, ids.m1],
      )).rejects.toThrow(/row-level security/)
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE receitas_rls_test')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [t])
      expect((await client.query('SELECT count(*)::int AS n FROM receita_titulos')).rows[0].n).toBeGreaterThan(0)
      await client.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.query('REVOKE ALL ON receita_titulos FROM receitas_rls_test').catch(() => {})
      client.release()
    }
  })
})
