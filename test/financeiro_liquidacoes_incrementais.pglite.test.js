import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { registrarBaixaIncremental } from '../src/services/financeiro-liquidacoes-incrementais.js'
import { darBaixaConciliacao, vincularLiquidacaoExistenteConciliacao } from '../src/services/conciliacao.js'

const tenantA = '10000000-0000-4000-8000-000000000001'
const tenantB = '20000000-0000-4000-8000-000000000002'
const titulo = '30000000-0000-4000-8000-000000000003'
const actor = { tipo: 'usuario', id: '40000000-0000-4000-8000-000000000004' }
const key = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('liquidação incremental — PGlite real', () => {
  let pg

  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`
      CREATE TABLE receita_titulos (
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, marca_id uuid,
        competencia date NOT NULL DEFAULT DATE '2026-10-01', componente text NOT NULL DEFAULT 'fixo',
        descricao text DEFAULT 'Título', valor_previsto numeric(15,2) NOT NULL,
        valor_pago numeric(15,2) NOT NULL DEFAULT 0, valor_perdido numeric(15,2),
        data_vencimento date DEFAULT DATE '2026-10-20', data_pagamento date,
        observacao text, perdido_em timestamptz, suspensao_comercial jsonb,
        atualizado_em timestamptz DEFAULT now()
      );
      CREATE TABLE financeiro_liquidacoes (
        id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid), tenant_id uuid NOT NULL,
        natureza text NOT NULL, origem_tipo text NOT NULL, origem_id uuid NOT NULL,
        valor numeric(15,2) NOT NULL, data_liquidacao date NOT NULL,
        comando_origem text NOT NULL, ator_tipo text NOT NULL, ator_id text NOT NULL,
        motivo text, idempotencia_chave text NOT NULL, idempotencia_payload jsonb NOT NULL,
        registrado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (tenant_id, idempotencia_chave)
      );
      CREATE TABLE financeiro_estornos (
        id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid), tenant_id uuid NOT NULL,
        liquidacao_id uuid NOT NULL, valor numeric(15,2) NOT NULL,
        registrado_em timestamptz NOT NULL DEFAULT clock_timestamp()
      );
    `)
  })

  beforeEach(async () => {
    await pg.exec('TRUNCATE financeiro_estornos, financeiro_liquidacoes, receita_titulos')
    await pg.query(
      `INSERT INTO receita_titulos (id,tenant_id,valor_previsto,valor_pago)
       VALUES ($1,$2,1000,400), ($3,$4,1000,0)`,
      [titulo, tenantA, titulo.replace(/3$/, '4'), tenantB],
    )
    await pg.query(
      `INSERT INTO financeiro_liquidacoes
         (tenant_id,natureza,origem_tipo,origem_id,valor,data_liquidacao,comando_origem,ator_tipo,ator_id,motivo,idempotencia_chave,idempotencia_payload)
       VALUES ($1,'receita','receita_titulo',$2,400,'2026-10-01','seed','sistema','seed',NULL,'seed', '{}'::jsonb)`,
      [tenantA, titulo],
    )
  })

  afterAll(async () => pg?.close())

  const input = (overrides = {}) => ({
    tenantId: tenantA, tipo: 'receita', id: titulo, valorOperacao: '300.00',
    data: '2026-10-09', chaveOperacao: key(1), ator: actor, hoje: '2026-10-09',
    ...overrides,
  })

  it('aplica 300 sobre 400, preserva o acumulado e informa residual 300', async () => {
    const result = await registrarBaixaIncremental(pg, input())
    expect(result).toMatchObject({
      valor_operacao: '300.00', valor_pago_anterior: '400.00',
      valor_pago: '700.00', saldo_restante: '300.00', replay: false,
      situacao_data: 'realizada', afeta_caixa_atual: true,
    })
    expect((await pg.query('SELECT valor_pago::text AS valor FROM receita_titulos WHERE id=$1', [titulo])).rows[0].valor).toBe('700.00')
  })

  it('faz replay sem duplicar e serializa payload conflitante', async () => {
    const first = await registrarBaixaIncremental(pg, input())
    const replay = await registrarBaixaIncremental(pg, input())
    expect(replay).toMatchObject({ liquidacao_id: first.liquidacao_id, replay: true })
    expect((await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE idempotencia_chave=$1', [key(1)])).rows[0].n).toBe(1)
    await expect(registrarBaixaIncremental(pg, input({ valorOperacao: '301.00' })))
      .rejects.toMatchObject({ code: 'FINANCEIRO_IDEMPOTENCIA_CONFLITO' })
  })

  it('replay de A após B devolve o mesmo resumo histórico de A', async () => {
    const a = await registrarBaixaIncremental(pg, input({ chaveOperacao: key(5) }))
    await registrarBaixaIncremental(pg, input({ chaveOperacao: key(6) }))
    const replayA = await registrarBaixaIncremental(pg, input({ chaveOperacao: key(5) }))
    expect(replayA).toMatchObject({
      replay: true,
      valor_pago_anterior: a.valor_pago_anterior,
      valor_pago: a.valor_pago,
      saldo_restante: a.saldo_restante,
    })
  })

  it('serializa duas requisições concorrentes com a mesma chave mesmo ao quitar o saldo', async () => {
    const operation = input({ valorOperacao: '600.00', chaveOperacao: key(8) })
    const [a, b] = await Promise.all([
      registrarBaixaIncremental(pg, operation),
      registrarBaixaIncremental(pg, operation),
    ])
    expect([a.replay, b.replay].sort()).toEqual([false, true])
    expect((await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE idempotencia_chave=$1', [key(8)])).rows[0].n).toBe(1)
    expect((await pg.query('SELECT valor_pago::text AS pago FROM receita_titulos WHERE id=$1', [titulo])).rows[0].pago).toBe('1000.00')
  })

  it('não deixa duas operações concorrentes excederem o residual', async () => {
    const settled = await Promise.allSettled([
      registrarBaixaIncremental(pg, input({ valorOperacao: '400.00', chaveOperacao: key(2) })),
      registrarBaixaIncremental(pg, input({ valorOperacao: '300.00', chaveOperacao: key(3) })),
    ])
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const row = (await pg.query('SELECT valor_pago::text AS pago FROM receita_titulos WHERE id=$1', [titulo])).rows[0]
    expect(Number(row.pago)).toBeLessThanOrEqual(1000)
  })

  it('mantém evento futuro fora do caixa atual', async () => {
    const result = await registrarBaixaIncremental(pg, input({ data: '2026-10-20', chaveOperacao: key(4) }))
    expect(result).toMatchObject({ situacao_data: 'agendada', afeta_caixa_atual: false })
    const realizado = await pg.query(
      `SELECT COALESCE(SUM(valor) FILTER (WHERE data_liquidacao <= $1::date),0)::text AS total
         FROM financeiro_liquidacoes WHERE tenant_id=$2 AND origem_id=$3`,
      ['2026-10-09', tenantA, titulo],
    )
    expect(realizado.rows[0].total).toBe('400.00')
  })

  it('recusa acesso cruzado entre tenants', async () => {
    await expect(registrarBaixaIncremental(pg, input({ tenantId: tenantB })))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('vincula uma liquidação já registrada sem criar outra', async () => {
    const baixa = await registrarBaixaIncremental(pg, input())
    const antes = (await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes')).rows[0].n
    const link = await vincularLiquidacaoExistenteConciliacao(pg, {
      tenantId: tenantA,
      transacao: { id: key(90), tipo: 'entrada', valor: '300.00', data: '2026-10-09' },
      tipo: 'receita', alvoId: titulo, liquidacaoId: baixa.liquidacao_id,
    })
    expect(link).toMatchObject({ aplicada: false, motivo: 'liquidacao_existente', liquidacao_id: baixa.liquidacao_id })
    expect((await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes')).rows[0].n).toBe(antes)
  })

  it('concilia 300 após baixa parcial de 400 e cria exatamente um novo fato incremental', async () => {
    const transacao = { id: key(91), tipo: 'entrada', valor: '300.00', data: '2026-10-09' }
    await pg.query('BEGIN')
    try {
      const baixa = await darBaixaConciliacao(pg, {
        tenantId: tenantA, transacao, tipo: 'receita', alvoId: titulo, userId: actor.id,
      })
      expect(baixa).toMatchObject({ aplicada: true, alvo_id: titulo })
      expect(Number(baixa.valor_pago)).toBe(700)
      await pg.query('COMMIT')
    } catch (error) {
      await pg.query('ROLLBACK').catch(() => {})
      throw error
    }

    expect((await pg.query(
      'SELECT valor_pago::text AS pago FROM receita_titulos WHERE tenant_id=$1 AND id=$2',
      [tenantA, titulo],
    )).rows[0].pago).toBe('700.00')
    const fatos = await pg.query(
      `SELECT valor::text AS valor FROM financeiro_liquidacoes
        WHERE tenant_id=$1 AND origem_tipo='receita_titulo' AND origem_id=$2
          AND idempotencia_chave LIKE $3`,
      [tenantA, titulo, `asaas:${transacao.id}:%`],
    )
    expect(fatos.rows).toEqual([{ valor: '300.00' }])
  })
})
