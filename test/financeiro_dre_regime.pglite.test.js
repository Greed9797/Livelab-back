import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lerMovimentosFinanceirosPeriodo, resumirRecebimentos } from '../src/services/financeiro-movimentos-periodo.js'
import { projetarDreCaixa, montarDre, montarDreDetalhe, normalizarRegimeDre, saldosDreCaixa } from '../src/services/financeiro-agregador.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), other = id(2), marca = id(3), titulo = id(4)
let pg
beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE marcas(id uuid,tenant_id uuid,nome text);
    CREATE TABLE clientes(id uuid,tenant_id uuid,nome text);
    CREATE TABLE receita_titulos(id uuid,tenant_id uuid,marca_id uuid,cliente_id uuid,componente text,
      competencia date,data_vencimento date,valor_pago numeric(15,2),data_pagamento date);
    CREATE TABLE receitas_avulsas(id uuid,tenant_id uuid,grupo text,competencia date,data_vencimento date,
      valor_pago numeric(15,2),data_pagamento date,descricao text);
    CREATE TABLE custos(id uuid,tenant_id uuid,tipo text,parcela_grupo_id uuid,recorrente_id uuid,
      grupo text,competencia date,data_vencimento date,valor_pago numeric(15,2),data_pagamento date,descricao text,classe_custo text);
    CREATE TABLE custos_recorrentes(id uuid,tenant_id uuid,classe_custo text);
    CREATE TABLE apresentadoras(id uuid,tenant_id uuid,nome text);
    CREATE TABLE apresentadora_pagamentos(id uuid,tenant_id uuid,apresentadora_id uuid,componente text,
      competencia date,valor_pago numeric(15,2),data_pagamento date);
    CREATE TABLE financeiro_liquidacoes(id uuid,tenant_id uuid,origem_tipo text,origem_id uuid,natureza text,
      data_liquidacao date,valor numeric(15,2));
    CREATE TABLE financeiro_estornos(id uuid,tenant_id uuid,liquidacao_id uuid,data_estorno date,valor numeric(15,2));
    INSERT INTO marcas VALUES ('${marca}','${tenant}','Marca A');
  `)
}, 30000)
afterAll(async () => pg.close())
beforeEach(async () => pg.exec('TRUNCATE receita_titulos,receitas_avulsas,custos,apresentadora_pagamentos,financeiro_liquidacoes,financeiro_estornos'))
const read = (de = '2026-10-01', ate = '2026-10-31', dataCorte = null) => lerMovimentosFinanceirosPeriodo(pg, { tenantId: tenant, de, ate, dataCorte })
const title = async (pago, data = '2026-10-05', venc = '2026-09-05') => pg.query(
  `INSERT INTO receita_titulos VALUES($1,$2,$3,NULL,'fixo','2024-01-01',$4,$5,$6)`, [titulo,tenant,marca,venc,pago,data])
const liq = async (n, valor, data, tipo = 'receita_titulo', origemId = titulo, natureza = 'receita', tid = tenant) => pg.query(
  `INSERT INTO financeiro_liquidacoes VALUES($1,$2,$3,$4,$5,$6,$7)`, [id(n),tid,tipo,origemId,natureza,data,valor])
const est = async (n, liquidacao, valor, data) => pg.query('INSERT INTO financeiro_estornos VALUES($1,$2,$3,$4,$5)',[id(n),tenant,id(liquidacao),data,valor])

describe('Caixa/vencimento: eventos SQL e uma fonte para Receita/DRE', () => {
  it('20 mil recebidos 05/out de título antigo vencido em outro mês contam outubro em ambas telas', async () => {
    await title('20000')
    await liq(10,'20000','2026-10-05')
    const { itens: movimentos } = await read()
    expect(movimentos).toHaveLength(1)
    const receita = resumirRecebimentos(movimentos)
    const itens = projetarDreCaixa({ itens: [], movimentos, inicio: '2026-10', fim: '2026-10' })
    const dre = montarDre({ meses: ['2026-10'], itens })
    const detalhe = montarDreDetalhe({ mes:'2026-10', itens })
    expect(receita.operacional).toBe(20000)
    expect(dre.meses[0].receita).toEqual({ previsto:0,realizado:20000 })
    expect(detalhe.receita.total.realizado).toBe(receita.operacional)
    expect(detalhe.receita.por_cliente[0].total.realizado).toBe(20000)
    expect(detalhe.receita.por_cliente[0].marcas[0].fixo.realizado).toBe(20000)
  })

  it('previsto outubro e recebido novembro; pago acumulado não vaza para outubro', async () => {
    await title('20000','2026-11-05','2026-10-05')
    await liq(10,'20000','2026-11-05')
    const { itens: movimentos } = await read('2026-10-01','2026-11-30')
    const itens = projetarDreCaixa({ itens:[{id:titulo,natureza:'receita',origem:'marca_fixo',grupo:'receita',componente:'fixo',
      marca_id:marca,marca_nome:'Marca A',competencia:'2024-01-01',data_vencimento:'2026-10-05',valor_previsto:20000,valor_pago:20000}],
      movimentos,inicio:'2026-10',fim:'2026-11' })
    const dre = montarDre({meses:['2026-10','2026-11'],itens})
    expect(dre.meses.map((m)=>m.receita)).toEqual([{previsto:20000,realizado:0},{previsto:0,realizado:20000}])
    expect(dre.totais.receita).toEqual({previsto:20000,realizado:20000})
  })

  it('duas baixas e estorno posterior ficam nos respectivos meses, sem duplicar GMV', async () => {
    await title('180.03','2026-11-06','2026-10-05')
    await liq(10,'100.01','2026-10-05'); await liq(11,'100.02','2026-11-05'); await est(12,10,'20.00','2026-11-06')
    const { itens: movimentos } = await read('2026-10-01','2026-11-30')
    const itens = projetarDreCaixa({itens:[{id:titulo,natureza:'receita',origem:'marca_fixo',grupo:'receita',componente:'fixo',
      marca_id:marca,competencia:'2024-01-01',data_vencimento:'2026-10-05',valor_previsto:200.03,valor_pago:180.03}],movimentos,inicio:'2026-10',fim:'2026-11'})
    const dre = montarDre({meses:['2026-10','2026-11'],itens})
    expect(dre.meses.map((m)=>m.receita.realizado)).toEqual([100.01,80.02])
    expect(dre.totais.receita.realizado).toBe(180.03)
    expect(montarDreDetalhe({mes:'2026-11',itens}).receita.total.realizado).toBe(80.02)
  })

  it('aporte, classe de custo, apresentadora, imposto e tenant mantêm classificação', async () => {
    await pg.exec(`INSERT INTO receitas_avulsas VALUES('${id(20)}','${tenant}','aporte','2026-01-01','2026-01-05',300,'2026-10-01','Capital');
      INSERT INTO custos VALUES('${id(21)}','${tenant}','outros',NULL,NULL,'operacao','2026-01-01','2026-02-01',50,'2026-10-02','Custo','fixo'),
        ('${id(22)}','${tenant}','imposto',NULL,NULL,'imposto','2026-01-01','2026-02-01',10,'2026-10-03','Imposto',NULL);
      INSERT INTO apresentadoras VALUES('${id(23)}','${tenant}','Ana');
      INSERT INTO apresentadora_pagamentos VALUES('${id(24)}','${tenant}','${id(23)}','variavel','2026-01-01',20,'2026-10-04');`)
    await liq(25,'999','2026-10-05','receita_titulo',titulo,'receita',other)
    const {itens:movimentos} = await read()
    expect(resumirRecebimentos(movimentos)).toMatchObject({operacional:0,aportes:300,total:300})
    const itens = projetarDreCaixa({itens:[],movimentos,inicio:'2026-10',fim:'2026-10'})
    const {totais} = montarDre({meses:['2026-10'],itens})
    expect(totais.aportes.realizado).toBe(300)
    expect(totais.custos_fixos.realizado).toBe(50)
    expect(totais.custos_variaveis.realizado).toBe(30)
    expect(totais.resultado.realizado).toBe(-80)
  })

  it('corte é por evento; não traz a baixa anterior à data de corte', async () => {
    await title('100','2026-10-20')
    await liq(10,'40','2026-10-05'); await liq(11,'60','2026-10-20')
    expect(resumirRecebimentos((await read('2026-10-01','2026-10-31','2026-10-10')).itens).operacional).toBe(60)
  })

  it('saldo inicial usa as mesmas parcelas e estornos do realizado mensal', async () => {
    await title('80','2026-11-05')
    await liq(10,'40','2026-09-05'); await liq(11,'60','2026-10-05'); await est(12,11,'20','2026-11-05')
    const saldos = await saldosDreCaixa(pg, {tenantId:tenant,meses:['2026-08','2026-10','2026-11','2026-12'],
      config:{data_corte:'2026-09-01',saldo_abertura:0}})
    expect(Object.fromEntries(saldos)).toEqual({'2026-08':null,'2026-10':40,'2026-11':100,'2026-12':80})
  })

  it('custo cancelado parcialmente pago preserva previsão liquidada sem descontar duas vezes', () => {
    const itens = projetarDreCaixa({itens:[{id:id(30),natureza:'custo',origem:'manual',grupo:'outros',classe:'variavel',
      competencia:'2026-09-01',data_vencimento:'2026-10-05',valor_previsto:100,valor_pago:30,
      data_pagamento:'2026-09-05',cancelado_em:'2026-10-01T00:00:00Z',status:'cancelado'}],
      movimentos:[],inicio:'2026-10',fim:'2026-10'})
    expect(montarDre({meses:['2026-10'],itens}).totais.custos_variaveis).toEqual({previsto:30,realizado:0})
    expect(montarDreDetalhe({mes:'2026-10',itens}).custos_variaveis.por_grupo[0].total.previsto).toBe(30)
  })

  it('legado datado é explícito e não soma duas vezes quando há eventos', async () => {
    await title('20000')
    expect((await read()).reconciliacao).toEqual({eventos_canonicos:0,movimentos_legados:1})
    await liq(10,'20000','2026-10-05')
    const result = await read()
    expect(result.reconciliacao).toEqual({eventos_canonicos:1,movimentos_legados:0})
    expect(resumirRecebimentos(result.itens).operacional).toBe(20000)
  })

  it('não inventa data ou resíduo para cobertura divergente', async () => {
    await title('20000'); await liq(10,'10000','2026-10-05')
    await expect(read()).rejects.toMatchObject({code:'FINANCIAL_RECONCILIATION_REQUIRED'})
    await pg.exec('TRUNCATE financeiro_liquidacoes'); await pg.query('UPDATE receita_titulos SET data_pagamento=NULL')
    await expect(read()).rejects.toMatchObject({code:'FINANCIAL_RECONCILIATION_REQUIRED'})
    expect(normalizarRegimeDre()).toBe('caixa_vencimento')
    expect(()=>normalizarRegimeDre('outro')).toThrow()
  })
})
