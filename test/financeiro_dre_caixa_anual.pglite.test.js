import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { calcularFluxoCaixa, calcularImpostos, calcularCaixa, calcularPainelMes, montarCaixa, montarPainel, montarFluxoCaixa, realizadoEntre, saldosCaixaInicioMeses, saldosDreCaixa } from '../src/services/financeiro-agregador.js'

import { lerMovimentosFinanceirosPeriodo, MOVIMENTOS_PERIODO_SQL } from '../src/services/financeiro-movimentos-periodo.js'

const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'

describe('DRE anual: saldo inicial de caixa por mês (PGlite)', () => {
  let db

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE TABLE marcas(id uuid, tenant_id uuid, nome text);
      CREATE TABLE clientes(id uuid, tenant_id uuid, nome text);
      CREATE TABLE receita_titulos (
        id uuid DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, marca_id uuid DEFAULT '33333333-3333-4333-8333-333333333333',
        cliente_id uuid, componente text DEFAULT 'fixo', competencia date, data_vencimento date,
        valor_pago numeric NOT NULL DEFAULT 0, data_pagamento date
      );
      CREATE TABLE receitas_avulsas (
        id uuid DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, grupo text, competencia date, data_vencimento date,
        descricao text, valor_pago numeric NOT NULL DEFAULT 0, data_pagamento date
      );
      CREATE TABLE custos (
        id uuid DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, tipo text, competencia date, data_vencimento date,
        parcela_grupo_id uuid, recorrente_id uuid, grupo text, descricao text, classe_custo text,
        valor_pago numeric NOT NULL DEFAULT 0, data_pagamento date
      );
      CREATE TABLE custos_recorrentes(id uuid, tenant_id uuid, classe_custo text);
      CREATE TABLE apresentadoras(id uuid, tenant_id uuid, nome text);
      CREATE TABLE apresentadora_pagamentos (
        id uuid DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, apresentadora_id uuid DEFAULT '44444444-4444-4444-8444-444444444444',
        componente text DEFAULT 'fixo', competencia date, valor_pago numeric NOT NULL DEFAULT 0, data_pagamento date
      );
      CREATE TABLE financeiro_liquidacoes(id uuid, tenant_id uuid, origem_tipo text, origem_id uuid, natureza text, data_liquidacao date, valor numeric);
      CREATE TABLE financeiro_estornos(id uuid, tenant_id uuid, liquidacao_id uuid, data_estorno date, valor numeric);
      INSERT INTO marcas VALUES ('33333333-3333-4333-8333-333333333333', '${T1}', 'Marca 1'), ('33333333-3333-4333-8333-333333333333', '${T2}', 'Marca 2');
      INSERT INTO apresentadoras VALUES ('44444444-4444-4444-8444-444444444444', '${T1}', 'Ana');
    `)
  })

  afterEach(async () => db.close())

  it('corte no meio do ano: null antes, abertura no mês do corte e competência antiga conta pela data do pagamento', async () => {
    await db.query(
      `INSERT INTO receita_titulos (tenant_id, competencia, valor_pago, data_pagamento) VALUES
       ($1, '2026-01-01', 500, '2026-07-20'),
       ($1, '2026-07-01', 200, '2026-08-02'),
       ($2, '2026-01-01', 9000, '2026-07-21')`,
      [T1, T2],
    )
    await db.query(
      `INSERT INTO receitas_avulsas (tenant_id, grupo, competencia, valor_pago, data_pagamento) VALUES
       ($1, 'aporte', '2026-07-01', 300, '2026-07-25')`, [T1],
    )
    await db.query(
      `INSERT INTO custos (tenant_id, tipo, competencia, valor_pago, data_pagamento) VALUES
       ($1, 'imposto', '2026-01-01', 50, '2026-07-28'),
       ($1, 'outros', '2026-07-01', 70, '2026-08-03')`, [T1],
    )
    await db.query(
      `INSERT INTO apresentadora_pagamentos (tenant_id, competencia, valor_pago, data_pagamento) VALUES
       ($1, '2026-06-01', 80, '2026-07-30')`, [T1],
    )

    const saldos = await saldosCaixaInicioMeses(db, {
      tenantId: T1,
      meses: ['2026-06', '2026-07', '2026-08', '2026-09'],
      config: { data_corte: '2026-07-15', saldo_abertura: 100 },
    })

    expect(Object.fromEntries(saldos)).toEqual({
      '2026-06': null,
      '2026-07': 100,
      '2026-08': 770,
      '2026-09': 900,
    })
  })

  it('saldo configurado em zero permanece 0; sem corte retorna null sem consultar movimentos', async () => {
    const zero = await saldosCaixaInicioMeses(db, {
      tenantId: T1,
      meses: ['2026-01', '2026-02'],
      config: { data_corte: '2026-01-01', saldo_abertura: 0 },
    })
    expect(Object.fromEntries(zero)).toEqual({ '2026-01': 0, '2026-02': 0 })

    const semCorte = await saldosCaixaInicioMeses(db, {
      tenantId: T1,
      meses: ['2026-01', '2026-02'],
      config: { data_corte: null, saldo_abertura: 999 },
    })
    expect(Object.fromEntries(semCorte)).toEqual({ '2026-01': null, '2026-02': null })
  })
  it('caixa, painel, fluxo, saldos e base de imposto atribuem 40/set, 60/out e estorno em novembro', async () => {
    const title = '55555555-5555-4555-8555-555555555555'
    const liqSet = '66666666-6666-4666-8666-666666666666'
    const liqOut = '77777777-7777-4777-8777-777777777777'
    await db.query(`INSERT INTO receita_titulos (id,tenant_id,competencia,data_vencimento,valor_pago,data_pagamento)
      VALUES($1,$2,'2024-01-01','2026-10-15',80,'2026-11-05')`, [title,T1])
    await db.query(`INSERT INTO financeiro_liquidacoes VALUES
      ($1,$3,'receita_titulo',$4,'receita','2026-09-05',40),
      ($2,$3,'receita_titulo',$4,'receita','2026-10-05',60)`, [liqSet,liqOut,T1,title])
    await db.query(`INSERT INTO financeiro_estornos VALUES(gen_random_uuid(),$1,$2,'2026-11-05',20)`, [T1,liqOut])
    const config = { data_corte: '2026-09-01', saldo_abertura: 100, aliquota_imposto_pct: 10 }
    const real = (de, ate) => realizadoEntre(db, { tenantId:T1, de, ate })
    const setembro = await real('2026-09-01','2026-09-30')
    const outubro = await real('2026-10-01','2026-10-31')
    const novembro = await real('2026-11-01','2026-11-30')
    expect([setembro.receitas,outubro.receitas,novembro.receitas]).toEqual([40,60,-20])
    expect(await real('2026-10-06','2026-10-31')).toMatchObject({entradas:0,saidas:0})
    const ateOut = await real(config.data_corte,'2026-10-31')
    expect(montarCaixa({config,ate:'2026-10-31',fimMes:'2026-10-31',realizado:ateOut,abertos:{a_receber:0,a_pagar:0}})).toMatchObject({saldo_atual:200})
    expect(montarPainel({mes:'2026-10',hoje:'2026-10-31',config,itens:[],realizadoAte:ateOut,realizadoMes:outubro})).toMatchObject({caixa:{saldo_atual:200},recebido_mes:{receitas:60,total:60}})
    const movimentos = (await lerMovimentosFinanceirosPeriodo(db,{tenantId:T1,de:'2026-09-01',ate:'2026-11-30'})).itens
    const itens = [{id:title,natureza:'receita',origem:'marca_fixo',competencia:'2024-01-01',data_vencimento:'2026-10-15',valor_previsto:100,valor_pago:80,data_pagamento:'2026-11-05'}]
    const fluxo = montarFluxoCaixa({mes:'2026-10',itens,movimentos,saldoInicial:140})
    expect(fluxo.totais.entradas).toEqual({previsto:100,realizado:60})
    expect(fluxo.serie_anual.slice(8,11).map((m)=>m.entradas.realizado)).toEqual([40,60,-20])
    expect(montarFluxoCaixa({mes:'2026-11',itens,movimentos,saldoInicial:200}).totais.saldo.realizado).toBe(-20)
    expect(montarFluxoCaixa({mes:'2026-11',itens}).totais.entradas.realizado).toBe(0) // agregado pago não é evento
    const params = {tenantId:T1,meses:['2026-12','2026-08','2026-10','2026-11','2026-09'],config}
    const saldos = await saldosCaixaInicioMeses(db,params)
    expect(Object.fromEntries(saldos)).toEqual({'2026-08':null,'2026-09':100,'2026-10':140,'2026-11':200,'2026-12':180})
    expect(await saldosDreCaixa(db,params)).toEqual(saldos)
    const impostos = await calcularImpostos(db,{tenantId:T1,inicio:'2026-10',fim:'2026-12',hoje:'2027-01-01',aliquota:10,dataCorte:config.data_corte})
    expect(impostos.map((i)=>[i.mes,i.mes_base,i.base,i.aliquota])).toEqual([['2026-10','2026-09',40,10],['2026-11','2026-10',60,10],['2026-12','2026-11',-20,10]])
    // Orquestração pública: eventos executam SQL real; motores de previsão ficam vazios.
    const scope = {query: (sql, values) => sql === MOVIMENTOS_PERIODO_SQL ? db.query(sql, values)
      : Promise.resolve({rows:String(sql).includes('SELECT aliquota_imposto_pct') ? [config] : []})}
    expect(await calcularFluxoCaixa(scope,{tenantId:T1,mes:'2026-10',hoje:'2027-01-01'})).toMatchObject({saldo_inicial:140,totais:{entradas:{realizado:60}}})
    expect(await calcularCaixa(scope,{tenantId:T1,ate:'2026-10-31',hoje:'2027-01-01'})).toMatchObject({saldo_atual:200,entradas_realizadas:100})
    expect(await calcularPainelMes(scope,{tenantId:T1,mes:'2026-10',hoje:'2027-01-01'})).toMatchObject({caixa:{saldo_atual:200},recebido_mes:{receitas:60}})
  })

  it('corte limita cada parcela e mantém aporte e saídas separados do recebido operacional', async () => {
    const title = '55555555-5555-4555-8555-555555555555'
    await db.query(`INSERT INTO receita_titulos (id,tenant_id,valor_pago,data_pagamento) VALUES($1,$2,100,'2026-10-20')`, [title,T1])
    await db.query(`INSERT INTO financeiro_liquidacoes VALUES
      (gen_random_uuid(),$1,'receita_titulo',$2,'receita','2026-10-05',40),
      (gen_random_uuid(),$1,'receita_titulo',$2,'receita','2026-10-20',60)`,[T1,title])
    await db.query(`INSERT INTO receitas_avulsas (tenant_id,grupo,valor_pago,data_pagamento) VALUES ($1,'aporte',500,'2026-10-21'),($1,'servico',10,'2026-10-21'),($2,'servico',9999,'2026-10-21')`,[T1,T2])
    await db.query(`INSERT INTO custos (tenant_id,tipo,valor_pago,data_pagamento) VALUES($1,'outros',20,'2026-10-22'),($1,'imposto',5,'2026-10-23')`,[T1])
    await db.query(`INSERT INTO apresentadora_pagamentos (tenant_id,valor_pago,data_pagamento) VALUES($1,15,'2026-10-24')`,[T1])
    expect(await realizadoEntre(db,{tenantId:T1,de:'2026-10-10',ate:'2026-10-31'})).toEqual({receitas:60,avulsas:10,aportes:500,custos:20,imposto:5,apresentadoras:15,entradas:570,saidas:40})
    const imposto = await calcularImpostos(db,{tenantId:T1,inicio:'2026-11',fim:'2026-11',hoje:'2026-12-01',aliquota:10,dataCorte:'2026-10-10'})
    expect(imposto[0]).toMatchObject({base:70,valor:7,base_tipo:'realizado'})
  })

  it('previsões incluem títulos e imposto antigos remarcados e usam corte por vencimento independente do pagamento', async () => {
    await db.exec(`
      ALTER TABLE marcas ADD tipo text, ADD tipo_cobranca text;
      ALTER TABLE receita_titulos ADD valor_previsto numeric, ADD observacao text,
        ADD perdido_em timestamptz, ADD perdido_motivo text, ADD perdido_por uuid,
        ADD valor_perdido numeric, ADD suspensao_comercial jsonb;
      ALTER TABLE custos ADD valor numeric, ADD parcela_num int, ADD parcelas_total int,
        ADD observacao text, ADD cancelado_em timestamptz, ADD cancelado_motivo text,
        ADD cancelado_por uuid, ADD criado_em timestamptz;
    `)
    await db.query(`INSERT INTO receita_titulos (tenant_id,competencia,data_vencimento,valor_previsto,valor_pago,data_pagamento) VALUES
      ($1,'2024-01-01','2026-10-20',100,0,NULL),
      ($1,'2026-10-01','2026-09-20',50,50,'2026-10-20'),
      ($1,'2026-10-01','2026-10-25',100,30,'2026-10-05')`,[T1])
    await db.query(`INSERT INTO custos (tenant_id,tipo,competencia,data_vencimento,valor,valor_pago) VALUES
      ($1,'imposto','2024-01-01','2026-10-22',70,0)`,[T1])
    const config = { data_corte:'2026-10-10', saldo_abertura:0, aliquota_imposto_pct:10 }
    // Executa os SELECTs reais de obrigações materializadas e movimentos. Motores
    // de contrato/recorrência, sem dados neste cenário, retornam vazio.
    const scope = {query:(sql,values) => sql === MOVIMENTOS_PERIODO_SQL ||
      sql.includes('FROM receita_titulos rt') || sql.includes('FROM custos\n        WHERE')
      ? db.query(sql,values)
      : Promise.resolve({rows:sql.includes('SELECT aliquota_imposto_pct') ? [config] : []})}
    const fluxo = await calcularFluxoCaixa(scope,{tenantId:T1,mes:'2026-10',hoje:'2027-01-01'})
    expect(fluxo.totais.entradas).toEqual({previsto:200,realizado:50})
    expect(fluxo.totais.saidas).toEqual({previsto:70,realizado:0})
    expect(fluxo.serie_anual[8].entradas.previsto).toBe(0)
    const caixa = await calcularCaixa(scope,{tenantId:T1,ate:'2026-10-31',hoje:'2027-01-01'})
    expect(caixa).toMatchObject({entradas_realizadas:50,a_receber:170,a_pagar:70})
    const painel = await calcularPainelMes(scope,{tenantId:T1,mes:'2026-10',hoje:'2027-01-01'})
    expect(painel.a_receber.total).toBe(caixa.a_receber)
    expect(painel.a_pagar.total).toBe(caixa.a_pagar)
    expect(painel.competencia.receita).toMatchObject({previsto:50,realizado:50})
  })

})
