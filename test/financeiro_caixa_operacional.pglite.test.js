import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { calcularCaixaOperacional } from '../src/services/financeiro-caixa-operacional.js'
import { selecionarObrigacoesPorVencimento } from '../src/services/financeiro-obrigacoes-vencimento.js'
import { lerSnapshotFinanceiro } from '../src/services/financeiro-read-snapshot.js'
import { parseConsultaQuery, selecionarConsulta, consultaCsv } from '../src/services/financeiro-consulta.js'
import { listarImpostos } from '../src/services/financeiro-agregador.js'
import { marcaFixoVigenciaSql } from '../src/lib/receita-marca-sql.js'
import { listarCustos } from '../src/services/custos-plano.js'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), other = id(2), brand = id(3), titleId = id(4)
let pg, queries, commercial
const db = { query(sql, params) {
  queries.push(sql)
  // These activity/remuneration engines are already exercised by their own
  // suites. All persisted obligations, joins, canonical events, cutoff, snapshot
  // and period selection below execute the production SQL in PostgreSQL.
  if (sql.includes('WITH comissao_marca')) return typeof commercial === 'function' ? commercial(params)
    : Promise.resolve({ rows: commercial.filter(r => r.competencia >= params[0] && r.competencia <= params[1]) })
  if (sql.includes('SELECT va.apresentadora_id, a.nome') || sql.includes('SELECT ara.id, ara.apresentadora_id')) return Promise.resolve({ rows: [] })
  return pg.query(sql, params)
} }
beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE tenants(id uuid,aliquota_imposto_pct numeric,financeiro_data_corte date,financeiro_saldo_abertura numeric(15,2),
      apresentadoras_fixo_vencimento_dia int,apresentadoras_fixo_vencimento_mes_offset int,
      apresentadoras_variavel_vencimento_dia int,apresentadoras_variavel_vencimento_mes_offset int);
    CREATE TABLE marcas(id uuid,tenant_id uuid,nome text,tipo text,tipo_cobranca text,
      data_inicio date DEFAULT '2026-09-01',data_fim date,criado_em timestamptz,status text DEFAULT 'ativa',sistema boolean DEFAULT false,
      valor_fixo_minimo numeric DEFAULT 0);
    CREATE TABLE marca_condicoes_comerciais(id uuid,tenant_id uuid,marca_id uuid,inicio_vigencia date,revision int,
      cancelled_at timestamptz,fixo_mensal numeric,tipo_cobranca text,comissao_franquia_pct numeric,
      fixo_vencimento_dia int,fixo_vencimento_mes_offset int,comissao_vencimento_dia int,comissao_vencimento_mes_offset int,comissao_janela_inicio_dia int);
    CREATE TABLE lives(id uuid,tenant_id uuid,iniciado_em timestamptz);
    CREATE TABLE clientes(id uuid,tenant_id uuid,nome text);
    CREATE TABLE receita_titulos(id uuid,tenant_id uuid,marca_id uuid,cliente_id uuid,componente text,
      competencia date,data_vencimento date,valor_previsto numeric(15,2),valor_pago numeric(15,2),data_pagamento date,
      observacao text,perdido_em timestamptz,perdido_motivo text,perdido_por uuid,valor_perdido numeric(15,2),suspensao_comercial jsonb);
    CREATE TABLE receitas_avulsas(id uuid,tenant_id uuid,grupo text,competencia date,data_vencimento date,
      valor_previsto numeric(15,2),valor_pago numeric(15,2),data_pagamento date,descricao text,observacao text,
      perdido_em timestamptz,perdido_motivo text,perdido_por uuid,valor_perdido numeric(15,2),criado_em timestamptz);
    CREATE TABLE custos(id uuid,tenant_id uuid,tipo text,parcela_grupo_id uuid,recorrente_id uuid,
      grupo text,competencia date,data_vencimento date,valor numeric(15,2),valor_pago numeric(15,2),data_pagamento date,
      descricao text,classe_custo text,observacao text,parcela_num int,parcelas_total int,
      cancelado_em timestamptz,cancelado_motivo text,cancelado_por uuid,criado_em timestamptz);
    CREATE TABLE custos_recorrentes(id uuid,tenant_id uuid,nome text,descricao text,grupo text,valor numeric(15,2),
      dia_vencimento int,mes_offset int,inicio date,fim date,ativo boolean,classe_custo text);
    CREATE TABLE apresentadoras(id uuid,tenant_id uuid,nome text,data_inicio date,data_fim date,ativo boolean DEFAULT true,
      arquivada boolean DEFAULT false,fixo numeric(15,2));
    CREATE TABLE apresentadora_fixo_historico(id uuid,tenant_id uuid,apresentadora_id uuid,vigencia_inicio date,valor numeric(15,2));
    CREATE TABLE vendas_atribuidas(id uuid,tenant_id uuid,apresentadora_id uuid,data date);
    CREATE TABLE apresentadora_remuneracao_adicionais(id uuid,tenant_id uuid,apresentadora_id uuid,competencia date,cancelado_em timestamptz);
    CREATE TABLE apresentadora_pagamentos(id uuid,tenant_id uuid,apresentadora_id uuid,componente text,
      competencia date,valor_pago numeric(15,2),data_pagamento date,observacao text,
      cancelado_em timestamptz,cancelado_motivo text,cancelado_por uuid);
    CREATE TABLE financeiro_liquidacoes(id uuid,tenant_id uuid,origem_tipo text,origem_id uuid,natureza text,
      data_liquidacao date,valor numeric(15,2));
    CREATE TABLE financeiro_estornos(id uuid,tenant_id uuid,liquidacao_id uuid,data_estorno date,valor numeric(15,2));
    INSERT INTO tenants VALUES ('${tenant}',0,'2026-10-01',1000,10,0,15,1),('${other}',0,'2026-10-01',999999,10,0,15,1);
    INSERT INTO marcas(id,tenant_id,nome,tipo,tipo_cobranca) VALUES ('${brand}','${tenant}','Marca A','cliente','fixo_mais_comissao'),('${brand}','${other}','Outro tenant','cliente','fixo_mais_comissao');
  `)
}, 30000)
afterAll(async () => pg.close())
beforeEach(async () => {
  queries = []; commercial = []
  await pg.exec('TRUNCATE receita_titulos,receitas_avulsas,custos,custos_recorrentes,financeiro_liquidacoes,financeiro_estornos,apresentadoras,apresentadora_pagamentos,apresentadora_fixo_historico,vendas_atribuidas,apresentadora_remuneracao_adicionais,marca_condicoes_comerciais,lives')
  await pg.query("UPDATE marcas SET data_inicio='2026-09-01',data_fim=NULL,valor_fixo_minimo=0")
  await pg.query('UPDATE tenants SET financeiro_data_corte=$1 WHERE id=$2', ['2026-10-01', tenant])
})
const title = (paid = '0.00', due = '2026-11-05') => pg.query(`INSERT INTO receita_titulos
  (id,tenant_id,marca_id,componente,competencia,data_vencimento,valor_previsto,valor_pago,data_pagamento)
  VALUES($1,$2,$3,'fixo','2024-01-01',$4,1000,$5,'2026-11-05')`, [titleId, tenant, brand, due, paid])
const event = (n, value, date, tid = tenant) => pg.query(`INSERT INTO financeiro_liquidacoes
  VALUES($1,$2,'receita_titulo',$3,'receita',$4,$5)`, [id(n),tid,titleId,date,value])

describe('caixa operacional: semântica PostgreSQL isolada', () => {
  it('antecipação, parcial futura e data de corte usam fatos uma vez e mantêm snapshot somente leitura', async () => {
    await title('1000.00')
    await event(10, '400.00', '2026-10-01')
    await event(11, '600.00', '2026-11-05')
    const result = await lerSnapshotFinanceiro(db, conn => calcularCaixaOperacional(conn, { tenantId: tenant, hoje: '2026-10-09' }))
    expect(result.caixa.saldo_atual).toBe('1400.00')
    expect(result.meses[0].saldo_final_projetado).toBe('1400.00')
    expect(result.meses[1]).toMatchObject({ entradas_projetadas: '600.00', saldo_final_projetado: '2000.00' })
    expect(result.obrigacoes.find(i => i.id === titleId)).toMatchObject({ saldo_aberto: '600.00', liquidado_na_data: '400.00' })
    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(queries.at(-1)).toBe('COMMIT')
    expect(queries.some(sql => /\b(INSERT INTO|UPDATE |DELETE FROM|CREATE TABLE)\b/i.test(sql))).toBe(false)
  })

  it('materializado antigo por vencimento e recorrente substituem virtual sem cruzar tenants', async () => {
    await title('0.00', '2026-10-20')
    await pg.exec(`INSERT INTO receita_titulos (id,tenant_id,marca_id,componente,competencia,data_vencimento,valor_previsto,valor_pago)
      VALUES('${id(21)}','${other}','${brand}','fixo','2024-01-01','2026-10-20',999999,0);
      INSERT INTO custos_recorrentes VALUES('${id(30)}','${tenant}','Cartão','Cartão','cartao',1500,5,0,'2026-10-01','2026-10-31',true,'fixo');
      INSERT INTO custos (id,tenant_id,tipo,recorrente_id,grupo,competencia,data_vencimento,valor,valor_pago,descricao)
      VALUES('${id(31)}','${tenant}','recorrente','${id(30)}','cartao','2026-10-01','2026-10-05',1200,0,'Cartão');`)
    const selection = await selecionarObrigacoesPorVencimento(db, { tenantId: tenant, de: '2026-10-01', ate: '2026-10-31', hoje: '2026-10-01' })
    expect(selection.map(i => i.id).sort()).toEqual([titleId, id(31)].sort())
    const opts = parseConsultaQuery({ eixo: 'vencimento', inicio: '2026-10', fim: '2026-10' })
    const list = await selecionarConsulta(db, { tenantId: tenant, filtros: opts.filtros, hoje: '2026-10-01' })
    expect(list.totais).toEqual({ previsto: '2200.00', pago: '0.00', aberto: '2200.00' })
    expect(consultaCsv(list)).toContain('"1200.00"')
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-01' })
    expect(result.meses[0]).toMatchObject({ menor_saldo_diario: '-200.00', primeiro_dia_negativo: '2026-10-05', saldo_final_projetado: '800.00' })
  })

  it('título movido para fora do horizonte suprime sua previsão virtual na competência', async () => {
    await title('0.00', '2027-04-05')
    await pg.query(`UPDATE receita_titulos SET competencia='2026-10-01'`)
    commercial = [{ marca_id: brand, competencia: '2026-10-01', fixo: 1000, comissao: 0, marca_nome: 'Marca A',
      marca_tipo: 'cliente', tipo_cobranca: 'fixo_mais_comissao', fixo_vencimento_dia: 5, fixo_vencimento_mes_offset: 1 }]
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.obrigacoes).toEqual([])
    expect(result.meses.every(m => m.entradas_projetadas === '0.00')).toBe(true)
  })

  it('reserva vencido sem movimento fictício mesmo antes do corte ou sem abertura configurada', async () => {
    await title('0.00', '2026-09-20')
    await pg.exec(`INSERT INTO custos (id,tenant_id,tipo,grupo,competencia,data_vencimento,valor,valor_pago,descricao)
      VALUES('${id(31)}','${tenant}','outros','operacao','2024-01-01','2026-09-05',300,0,'Obrigação antiga')`)
    for (const corte of ['2026-10-01', null]) {
      await pg.query('UPDATE tenants SET financeiro_data_corte=$1 WHERE id=$2', [corte, tenant])
      const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
      expect(result.pendencias.recebiveis_vencidos.map(i => i.id)).toContain(titleId)
      expect(result.pendencias.pagaveis_vencidos.map(i => i.id)).toContain(id(31))
      expect(result.caixa.reserva_pagaveis_vencidos).toBe('300.00')
      expect(result.caixa.saldo_atual).toBe(corte ? '1000.00' : null)
      expect(result.caixa.saldo_disponivel).toBe(corte ? '700.00' : null)
      expect(result.meses[0]).toMatchObject({ entradas_projetadas: '0.00', saidas_projetadas: '0.00' })
    }
    await pg.query('UPDATE tenants SET financeiro_data_corte=$1 WHERE id=$2', ['2026-10-01', tenant])
  })

  it('liquidações parciais em datas distintas e estorno mantêm acumulado e período no JSON/CSV', async () => {
    await title('900.00', '2026-10-20')
    await event(10, '400.00', '2026-10-05')
    await event(11, '600.00', '2026-11-05')
    await pg.exec(`INSERT INTO financeiro_estornos VALUES('${id(12)}','${tenant}','${id(11)}','2026-12-05',100)`)
    for (const [month, expected] of [['2026-10', '400.00'], ['2026-11', '600.00'], ['2026-12', '-100.00']]) {
      const { filtros } = parseConsultaQuery({ eixo: 'pagamento', inicio: month, fim: month, competencia_inicio: '2024-01', competencia_fim: '2024-01' })
      const result = await selecionarConsulta(db, { tenantId: tenant, filtros, hoje: '2026-12-09' })
      expect(result.itens).toHaveLength(1)
      expect(result.itens[0]).toMatchObject({ valor_pago: '900.00', liquidado_no_periodo: expected })
      expect(result.totais.liquidado_no_periodo).toBe(expected)
      expect(consultaCsv(result)).toContain(`"${expected}"`)
    }
  })

  it('histórico de apresentadora parcial e recorrente virtual entra na reserva sem cap temporal', async () => {
    await pg.exec(`
      INSERT INTO apresentadoras(id,tenant_id,nome,data_inicio,data_fim,fixo) VALUES
        ('${id(40)}','${tenant}','Ana','2024-01-01','2024-01-31',1000);
      INSERT INTO apresentadora_pagamentos(id,tenant_id,apresentadora_id,componente,competencia,valor_pago,data_pagamento)
        VALUES('${id(41)}','${tenant}','${id(40)}','fixo','2024-01-01',400,'2024-01-10');
      INSERT INTO custos_recorrentes VALUES
        ('${id(42)}','${tenant}','Aluguel histórico','Aluguel','operacao',250,5,0,'2023-01-01','2023-01-31',true,'fixo'),
        ('${id(43)}','${other}','Outro tenant','Outro','operacao',99999,5,0,'2010-01-01','2010-01-31',true,'fixo'),
        ('${id(44)}','${tenant}','A vencer','A vencer','operacao',100,20,0,'2026-10-01','2026-10-31',true,'fixo');
    `)
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.pendencias.pagaveis_vencidos.find(i => i.origem === 'apresentadora')).toMatchObject({
      competencia: '2024-01-01', valor_original: '1000.00', liquidado_acumulado: '400.00', saldo_aberto: '600.00',
    })
    expect(result.pendencias.pagaveis_vencidos.find(i => i.recorrente_id === id(42))).toMatchObject({
      competencia: '2023-01-01', virtual: true, saldo_aberto: '250.00',
    })
    expect(result.caixa).toMatchObject({ saldo_atual: '1000.00', reserva_pagaveis_vencidos: '850.00', saldo_disponivel: '150.00' })
    expect(result.completude.historico_obrigacoes_completo).toBe(true)
    expect(result.pendencias.pagaveis_vencidos.some(i => i.recorrente_id === id(43))).toBe(false)
    expect(result.pendencias.pagaveis_vencidos.some(i => i.recorrente_id === id(44))).toBe(false)
    expect(result.meses[0].saidas_projetadas).toBe('100.00')
  })

  it('início histórico desconhecido não fabrica fixo vencido ao expandir outra fonte', async () => {
    await pg.exec(`
      INSERT INTO apresentadoras(id,tenant_id,nome,data_fim,fixo) VALUES
        ('${id(50)}','${tenant}','Sem início','2026-09-30',1000),
        ('${id(51)}','${other}','Outro tenant',null,99999);
      INSERT INTO custos_recorrentes VALUES
        ('${id(52)}','${tenant}','Histórico conhecido','Operação','operacao',25,5,0,'2020-01-01','2020-01-31',true,'fixo');
    `)
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.caixa.reserva_pagaveis_vencidos).toBe('25.00')
    expect(result.obrigacoes.some(i => i.apresentadora_id === id(50))).toBe(false)
    expect(result.completude.historico_obrigacoes_completo).toBe(false)
    expect(result.pendencias.historico).toEqual([expect.objectContaining({
      origem: 'apresentadora', id: id(50), motivo: 'inicio_historico_desconhecido', valor: null,
    })])
  })

  it('fixo histórico de inativa fora do motor fica desconhecido sem alterar remuneração', async () => {
    await pg.exec(`
      INSERT INTO apresentadoras(id,tenant_id,nome,data_inicio,data_fim,ativo,fixo) VALUES
        ('${id(60)}','${tenant}','Inativa','2024-01-01','2024-01-31',false,1000);
      INSERT INTO apresentadora_pagamentos(id,tenant_id,apresentadora_id,componente,competencia,valor_pago,data_pagamento)
        VALUES('${id(61)}','${tenant}','${id(60)}','fixo','2024-01-01',400,'2024-01-10');
    `)
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.caixa.reserva_pagaveis_vencidos).toBe('0.00')
    expect(result.completude.historico_obrigacoes_completo).toBe(false)
    expect(result.pendencias.historico).toEqual([expect.objectContaining({
      origem: 'apresentadora', id: id(60), motivo: 'fixo_historico_indisponivel', valor: null,
    })])
  })

  it('materializados antigos sem vencimento ficam pendentes e incompletos', async () => {
    await title('0.00', null)
    await pg.exec(`
      INSERT INTO custos(id,tenant_id,tipo,grupo,competencia,valor,valor_pago,descricao) VALUES
        ('${id(70)}','${tenant}','outros','operacao','2020-01-01',200,0,'Custo sem data');
      INSERT INTO receitas_avulsas(id,tenant_id,grupo,competencia,valor_previsto,valor_pago,descricao) VALUES
        ('${id(71)}','${tenant}','receita','2020-01-01',300,0,'Receita sem data');
    `)
    const legacy = await listarCustos(db, { tenantId: tenant, inicio: '2026-10', fim: '2026-10', hoje: '2026-10-09' })
    expect(legacy).toEqual([])
    expect(queries.some(sql => /FROM custos\s+WHERE tenant_id = \$1::uuid\s+AND competencia >= \$2::date AND competencia <= \$3::date/.test(sql))).toBe(true)
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.pendencias.sem_data.map(i => i.id).sort()).toEqual([titleId, id(70), id(71)].sort())
    expect(result.completude.obrigacoes_com_data).toBe(false)
    expect(result.meses.every(m => m.entradas_projetadas === '0.00' && m.saidas_projetadas === '0.00')).toBe(true)
  })

  it('histórico comercial virtual independe de outras fontes e usa vigência real', async () => {
    await pg.query("UPDATE marcas SET data_inicio='2024-01-01',data_fim='2024-01-31',valor_fixo_minimo=1000 WHERE tenant_id=$1", [tenant])
    commercial = params => pg.query(`SELECT v.marca_id,v.marca_nome,'cliente' AS marca_tipo,v.mes AS competencia,
      v.tipo_cobranca,v.valor_fixo_minimo*v.fator_meses AS fixo,v.valor_fixo_minimo AS fixo_cheio,v.fator_meses,
      0 AS comissao,10 AS fixo_vencimento_dia,0 AS fixo_vencimento_mes_offset
      FROM (${marcaFixoVigenciaSql()}) v`, params)
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.pendencias.recebiveis_vencidos).toEqual([expect.objectContaining({
      marca_id: brand, competencia: '2024-01-01', virtual: true, saldo_aberto: '1000.00',
    })])
    expect(result.completude.historico_obrigacoes_completo).toBe(true)
    expect(result.meses.every(m => m.entradas_projetadas === '0.00')).toBe(true)
  })

  it('inativa com início conhecido sem baixa mantém fixo histórico desconhecido', async () => {
    await pg.exec(`INSERT INTO apresentadoras(id,tenant_id,nome,data_inicio,data_fim,ativo,fixo)
      VALUES('${id(72)}','${tenant}','Inativa sem baixa','2024-01-01','2024-01-31',false,1000)`)
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.pendencias.historico).toContainEqual(expect.objectContaining({
      origem: 'apresentadora', id: id(72), motivo: 'fixo_historico_indisponivel', valor: null,
    }))
    expect(result.completude.historico_obrigacoes_completo).toBe(false)
  })

  it.each(['2026-11-05', '2027-05-05'])('pagamento futuro %s não encerra reserva na data-base', async (date) => {
    await pg.exec(`
      INSERT INTO custos(id,tenant_id,tipo,grupo,competencia,data_vencimento,valor,valor_pago,data_pagamento,descricao)
        VALUES('${id(73)}','${tenant}','outros','operacao','2026-09-01','2026-09-20',100,100,'${date}','Dívida vencida');
      INSERT INTO financeiro_liquidacoes VALUES('${id(74)}','${tenant}','custo','${id(73)}','custo','${date}',100);
    `)
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.caixa).toMatchObject({ saldo_atual: '1000.00', reserva_pagaveis_vencidos: '100.00', saldo_disponivel: '900.00' })
    expect(result.pendencias.pagaveis_vencidos[0]).toMatchObject({ valor_pago: '100.00', liquidado_na_data: '0.00', saldo_aberto: '100.00' })
    expect(result.meses[0].saidas_projetadas).toBe('0.00')
    if (date < result.horizonte.fim) {
      expect(result.serie_diaria.find(d => d.dia === date)).toMatchObject({ saidas_projetadas: '100.00', reserva_vencida: '0.00', saldo_disponivel_projetado: '900.00' })
    } else {
      expect(result.pendencias.movimentos_futuros).toEqual([])
      expect(result.serie_diaria.at(-1)).toMatchObject({ reserva_vencida: '100.00', saldo_disponivel_projetado: '900.00' })
    }
  })

  it.each(['2026-11-05', '2027-05-05'])('estorno futuro %s reabre reserva apenas na data registrada', async (date) => {
    await pg.exec(`
      INSERT INTO custos(id,tenant_id,tipo,grupo,competencia,data_vencimento,valor,valor_pago,data_pagamento,descricao)
        VALUES('${id(75)}','${tenant}','outros','operacao','2026-09-01','2026-09-20',100,0,'2026-09-20','Dívida quitada');
      INSERT INTO financeiro_liquidacoes VALUES('${id(76)}','${tenant}','custo','${id(75)}','custo','2026-09-20',100);
      INSERT INTO financeiro_estornos VALUES('${id(77)}','${tenant}','${id(76)}','${date}',100);
    `)
    const result = await calcularCaixaOperacional(db, { tenantId: tenant, hoje: '2026-10-09' })
    expect(result.caixa).toMatchObject({ saldo_atual: '1000.00', reserva_pagaveis_vencidos: '0.00', saldo_disponivel: '1000.00' })
    expect(result.obrigacoes.find(i => i.id === id(75))).toMatchObject({ liquidado_na_data: '100.00', saldo_aberto: '0.00' })
    if (date < result.horizonte.fim) {
      expect(result.serie_diaria.find(d => d.dia === date)).toMatchObject({ entradas_projetadas: '100.00', reserva_vencida: '100.00', saldo_disponivel_projetado: '1000.00' })
    } else expect(result.serie_diaria.at(-1).reserva_vencida).toBe('0.00')
  })

  it('rollback aguarda ramo interno de imposto que ainda pode agendar leituras', async () => {
    let release, started, finished = false
    const gate = new Promise(resolve => { release = resolve })
    const waiting = new Promise(resolve => { started = resolve })
    const failure = new Error('materializado indisponível')
    const slowDb = { async query(sql, params) {
      if (sql.includes("tipo = 'imposto'")) { queries.push(sql); throw failure }
      if (sql.includes('WITH origens AS')) { started(); await gate }
      return db.query(sql, params)
    } }
    const read = lerSnapshotFinanceiro(slowDb, conn => listarImpostos(conn, {
      tenantId: tenant, inicio: '2026-10', fim: '2027-03', hoje: '2026-10-09', aliquota: 0, dataCorte: null,
    })).then(() => null, error => { finished = true; return error })
    await waiting
    await new Promise(resolve => setImmediate(resolve))
    const finishedWhilePending = finished
    release()
    expect(await read).toBe(failure)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(finishedWhilePending).toBe(false)
    expect(queries.at(-1)).toBe('ROLLBACK')
  })

  it('divergência canônica provoca rollback e nunca confirma saldo', async () => {
    await title('1000.00')
    await event(10, '400.00', '2026-10-05')
    await expect(lerSnapshotFinanceiro(db, conn => calcularCaixaOperacional(conn, { tenantId: tenant, hoje: '2026-10-09' })))
      .rejects.toMatchObject({ code: 'FINANCIAL_RECONCILIATION_REQUIRED', statusCode: 409 })
    expect(queries.at(-1)).toBe('ROLLBACK')
  })
})
