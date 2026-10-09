import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lerMovimentosFinanceirosPeriodo, MOVIMENTOS_PERIODO_SQL } from '../src/services/financeiro-movimentos-periodo.js'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), other = id(2), brand = id(3), titleId = id(4)
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
    INSERT INTO marcas VALUES ('${brand}','${tenant}','Marca A');
  `)
}, 30000)
afterAll(async () => pg.close())
beforeEach(async () => pg.exec('TRUNCATE receita_titulos,financeiro_liquidacoes,financeiro_estornos'))
const read = (dataCorte = null) => lerMovimentosFinanceirosPeriodo(pg, {
  tenantId: tenant, de: '2026-10-01', ate: '2026-10-31', dataCorte,
})
const title = async paid => pg.query(`INSERT INTO receita_titulos VALUES($1,$2,$3,NULL,'fixo',
  '2026-09-01','2026-10-05',$4,'2026-11-05')`, [titleId, tenant, brand, paid])
const event = async ({ n = 10, amount = 20, date = '2026-11-05', natureza = 'receita', tid = tenant } = {}) => pg.query(
  `INSERT INTO financeiro_liquidacoes VALUES($1,$2,'receita_titulo',$3,$4,$5,$6)`, [id(n), tid, titleId, natureza, date, amount])
const error = motivo => ({ statusCode: 409, code: 'FINANCIAL_RECONCILIATION_REQUIRED',
  divergencias: [{ origem_tipo: 'receita_titulo', origem_id: titleId, motivo }] })

describe('movimentos: reconciliação independente do período', () => {
  it('reconciliação obrigatória para legado pago sem data não retorna saldo parcial', async () => {
    await title('100.00')
    await pg.query('UPDATE receita_titulos SET data_pagamento = NULL')
    await expect(read()).rejects.toMatchObject(error('pagamento_sem_data'))
  })

  it('liquidações parciais em datas distintas preservam cada valor exato', async () => {
    await title('1000.00')
    await event({ amount: '400.00', date: '2026-10-05' })
    await event({ n: 11, amount: '600.00', date: '2026-11-05' })
    const october = await lerMovimentosFinanceirosPeriodo(pg, { tenantId: tenant, de: '2026-10-01', ate: '2026-10-31', dinheiroExato: true })
    const november = await lerMovimentosFinanceirosPeriodo(pg, { tenantId: tenant, de: '2026-11-01', ate: '2026-11-30', dinheiroExato: true })
    expect(october.itens.map(i => i.valor)).toEqual(['400.00'])
    expect(november.itens.map(i => i.valor)).toEqual(['600.00'])
  })

  it('outubro sem eventos acusa legado100 + canônico20 em novembro com projeção120', async () => {
    await title(120)
    await event()
    await expect(read()).rejects.toMatchObject(error('saldo_divergente'))
    const { rows } = await pg.query(MOVIMENTOS_PERIODO_SQL, [tenant, '2026-10-01', '2026-10-31', null])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tipo: 'revisao', data: null, valor: '0', inconsistencia: 'saldo_divergente' })
    expect((await pg.query('SELECT valor_pago::text AS pago FROM receita_titulos')).rows).toEqual([{ pago: '120.00' }])
  })

  it('data de corte não oculta divergência de evento anterior ao corte', async () => {
    await title(120)
    await event({ date: '2026-10-05' })
    await expect(read('2026-10-10')).rejects.toMatchObject(error('saldo_divergente'))
  })

  it('origem ausente é acusada mesmo com todos eventos fora do intervalo', async () => {
    await event()
    await expect(read()).rejects.toMatchObject(error('origem_ausente'))
  })

  it('natureza divergente fora do intervalo prevalece mesmo com saldo coberto', async () => {
    await title(20)
    await event({ natureza: 'custo' })
    await expect(read()).rejects.toMatchObject(error('natureza_divergente'))
  })

  it('naturezas mistas geram uma única revisão por obrigação, sem duplicar movimentos', async () => {
    await title(40)
    await event({ date: '2026-10-05' })
    await event({ n: 11, natureza: 'custo', date: '2026-10-06' })
    await expect(read()).rejects.toMatchObject(error('natureza_divergente'))
    const { rows } = await pg.query(MOVIMENTOS_PERIODO_SQL, [tenant, '2026-10-01', '2026-10-31', null])
    expect(rows.filter(r => r.tipo === 'liquidacao')).toHaveLength(2)
    expect(rows.filter(r => r.inconsistencia)).toHaveLength(1)
  })

  it('cobertura íntegra fora do mês ou antes do corte retorna zero sem sentinela', async () => {
    await title(20)
    await event()
    expect(await read()).toEqual({ itens: [], reconciliacao: { eventos_canonicos: 0, movimentos_legados: 0 } })
    await pg.query(`UPDATE financeiro_liquidacoes SET data_liquidacao='2026-10-05'`)
    expect((await read('2026-10-10')).itens).toEqual([])
    expect((await read()).itens).toHaveLength(1)
  })

  it('inconsistências de outro tenant não bloqueiam a leitura', async () => {
    await title(20)
    await event()
    await event({ n: 11, amount: 999, natureza: 'custo', tid: other })
    expect((await read()).itens).toEqual([])
  })
})
