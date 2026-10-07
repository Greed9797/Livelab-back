import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { condicaoVigenteLateralSql } from '../src/lib/receita-marca-sql.js'
import { resolveMarcaCondicao } from '../src/lib/marca-condicoes.js'

// Revenue assembly has its own integration suite. This fixture executes the actual
// temporal SQL and every CRUD/ledger mutation, using materialized monthly titles.
vi.mock('../src/services/receitas-comercial.js', () => ({
  calcularReceitasComerciais: async (db, { tenantId, inicio, fim }) => {
    const { condicaoVigenteLateralSql } = await import('../src/lib/receita-marca-sql.js')
    const result = await db.query(`SELECT rt.marca_id, rt.competencia, rt.componente,
        mc.fixo_mensal AS valor, rt.data_vencimento
      FROM receita_titulos rt
      ${condicaoVigenteLateralSql({ marcaExpr: 'rt.marca_id', mesExpr: 'rt.competencia' })}
      WHERE rt.tenant_id=$3::uuid AND rt.competencia BETWEEN $1::date AND $2::date AND mc.fixo_mensal > 0`, [inicio, fim, tenantId])
    return result.rows
  },
}))
import { atualizarCondicaoMarca, excluirCondicaoMarca, preverMutacaoCondicaoMarca } from '../src/services/marca-condicoes-mutations.js'
import { confirmarCondicaoMarca, listarCondicoesMarca } from '../src/services/marca-condicoes.js'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant=id(1), brand=id(2), other=id(3), jan=id(11), mar=id(12), may=id(13)
const base = { tenantId: tenant, marcaId: brand, condicaoId: mar, motivo: 'Ajuste autorizado do contrato' }
let db
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE clientes(id uuid PRIMARY KEY);
    CREATE TABLE marcas(id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), cliente_id uuid,
      nome text, tipo text, valor_fixo_minimo numeric(15,2), comissao_franquia_pct numeric(5,2),
      comissao_franqueadora_pct numeric(5,2), tipo_cobranca text, atualizado_em timestamptz);
    CREATE TABLE lives(id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, iniciado_em timestamptz,
      fat_gerado numeric(15,2), comissao_calculada numeric(15,2), faturado_em timestamptz,
      uniao_destino_id uuid, uniao_desfeita_em timestamptz);
    CREATE TABLE vendas_atribuidas(id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, data date,
      gmv numeric(15,2), status_aprovacao text, comissao_franquia numeric(15,2),
      comissao_franqueadora numeric(15,2), marca_condicao_id uuid, atualizado_em timestamptz);
    CREATE TABLE audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, user_id uuid,
      action text, entity_type text, entity_id uuid, metadata jsonb);
    CREATE TABLE financeiro_liquidacoes(id uuid PRIMARY KEY, origem_id uuid, valor numeric(15,2));
    CREATE TABLE snapshots_fechados(id uuid PRIMARY KEY, dados jsonb);
    INSERT INTO tenants VALUES ('${tenant}'),('${other}');
    INSERT INTO marcas VALUES ('${brand}','${tenant}',NULL,'Cliente','cliente',999,99,99,'fixo_mais_comissao',NOW());`)
  for (const file of ['151_marca_condicoes_comerciais.sql','165_receita_titulos_vencimento_condicoes.sql','179_condicoes_comissao_janela.sql','184_receita_titulos_suspensao_comercial.sql']) {
    await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
  }
  await db.exec('ALTER TABLE receita_titulos ADD COLUMN valor_perdido numeric(15,2) DEFAULT 0, ADD COLUMN perdido_em timestamptz')
})
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`TRUNCATE marca_condicoes_comerciais, receita_titulos, audit_log, lives, vendas_atribuidas, financeiro_liquidacoes, snapshots_fechados;
    INSERT INTO marca_condicoes_comerciais (id,tenant_id,marca_id,inicio_vigencia,fixo_mensal,comissao_franquia_pct,
      comissao_franqueadora_pct,tipo_cobranca,fixo_confirmado,comissao_confirmada,origem,revision) VALUES
      ('${jan}','${tenant}','${brand}','2026-01-01',100,5,2,'fixo_mais_comissao',true,true,'gestao',1),
      ('${mar}','${tenant}','${brand}','2026-03-01',200,10,2,'fixo_mais_comissao',true,true,'gestao',2),
      ('${may}','${tenant}','${brand}','2026-05-01',300,15,2,'fixo_mais_comissao',true,true,'gestao',3);
    INSERT INTO receita_titulos(id,tenant_id,marca_id,competencia,componente,valor_previsto,valor_pago,data_pagamento,data_vencimento) VALUES
      ('${id(21)}','${tenant}','${brand}','2026-03-01','fixo',200,50,'2026-04-05','2026-04-05'),
      ('${id(22)}','${tenant}','${brand}','2026-04-01','fixo',200,200,'2026-05-05','2026-05-05'),
      ('${id(23)}','${tenant}','${brand}','2026-05-01','fixo',300,0,NULL,'2026-06-05');
    INSERT INTO lives VALUES
      ('${id(31)}','${tenant}','${brand}','2026-03-15T12:00:00Z',1000,100,NULL,NULL,NULL),
      ('${id(32)}','${tenant}','${brand}','2026-04-15T12:00:00Z',1000,100,NOW(),NULL,NULL),
      ('${id(33)}','${tenant}','${brand}','2026-05-15T12:00:00Z',1000,150,NULL,NULL,NULL);
    INSERT INTO vendas_atribuidas VALUES
      ('${id(41)}','${tenant}','${brand}','2026-03-15',1000,'pendente_aprovacao',100,20,'${mar}',NULL),
      ('${id(42)}','${tenant}','${brand}','2026-04-15',1000,'aprovada',100,20,'${mar}',NULL);
    INSERT INTO financeiro_liquidacoes VALUES ('${id(51)}','${id(21)}',50),('${id(52)}','${id(22)}',200);
    INSERT INTO snapshots_fechados VALUES ('${id(61)}','{"receita":400}');`)
})
const months = async () => (await db.query(`SELECT to_char(gs.mes,'YYYY-MM') AS mes, mc.fixo_mensal AS fixo
  FROM generate_series('2026-01-01'::date,'2026-06-01'::date,'1 month') gs(mes)
  ${condicaoVigenteLateralSql({ marcaExpr: '$2::uuid', mesExpr: 'gs.mes', tenantParam: '$1' })}`, [tenant,brand])).rows.map(r=>Number(r.fixo))
const revision = async () => Math.max(...(await listarCondicoesMarca(db,base)).map(c=>c.revision))

describe('commercial competency CRUD with real SQL', () => {
  it('preview rolls back simulation; deletion creates March/April gap and preserves paid facts, snapshots and May', async () => {
    const preview = await preverMutacaoCondicaoMarca(db,{...base,operacao:'excluir'})
    expect(preview).toMatchObject({expected_revision:3,bloqueada:false,fim_vigencia_exclusivo:'2026-05-01'})
    expect(preview.financeiro).toMatchObject({valor_pago_preservado:'250.00',saldo_aberto_depois:'0.00'})
    expect(await months()).toEqual([100,100,200,200,300,300])
    const result = await excluirCondicaoMarca(db,{...base,expectedRevision:3,idempotencyKey:'cancel-mar'})
    expect(result.condition.revision).toBe(4)
    expect(await months()).toEqual([100,100,0,0,300,300])
    const rows = await listarCondicoesMarca(db,base)
    expect(rows.find(r=>r.id===mar).cancelled_at).not.toBeNull()
    expect(resolveMarcaCondicao(rows,'2026-04-15')).toBeNull()
    expect((await db.query('SELECT valor::text FROM financeiro_liquidacoes ORDER BY id')).rows).toEqual([{valor:'50.00'},{valor:'200.00'}])
    expect((await db.query('SELECT dados FROM snapshots_fechados')).rows[0].dados).toEqual({receita:400})
    expect((await db.query('SELECT comissao_calculada::text AS n FROM lives ORDER BY id')).rows).toEqual([{n:'0.00'},{n:'100.00'},{n:'150.00'}])
    expect((await db.query('SELECT comissao_franquia::text AS n FROM vendas_atribuidas ORDER BY id')).rows).toEqual([{n:'0.00'},{n:'100.00'}])
  })
  it('edit below received reports excess and preserves fully paid title and successor', async () => {
    const result=await atualizarCondicaoMarca(db,{...base,proposta:{fixo_mensal:40},expectedRevision:3,idempotencyKey:'edit-mar'})
    expect(result.preview.financeiro.excesso_recebido).toBe('170.00')
    expect(await months()).toEqual([100,100,40,40,300,300])
    expect((await db.query('SELECT valor_pago::text AS pago,valor_previsto::text AS previsto FROM receita_titulos ORDER BY id')).rows)
      .toEqual([{pago:'50.00',previsto:'50.00'},{pago:'200.00',previsto:'200.00'},{pago:'0.00',previsto:'300.00'}])
  })
  it('replay succeeds with old revision; key reuse rejects another operation; stale competing edit cannot win', async () => {
    const args={...base,expectedRevision:3,idempotencyKey:'same'}
    const original=await excluirCondicaoMarca(db,args)
    expect((await excluirCondicaoMarca(db,args)).idempotent).toBe(true)
    await expect(atualizarCondicaoMarca(db,{...args,proposta:{fixo_mensal:1}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'})
    await expect(atualizarCondicaoMarca(db,{...base,condicaoId:jan,expectedRevision:3,idempotencyKey:'competing',proposta:{fixo_mensal:1}})).rejects.toMatchObject({code:'STALE_REVISION'})
    expect(await revision()).toBe(original.condition.revision)
    expect((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(1)
  })
  it('scope, reason and immutable start reject without changes', async () => {
    await expect(excluirCondicaoMarca(db,{...base,tenantId:other,expectedRevision:3,idempotencyKey:'other'})).rejects.toMatchObject({code:'MARCA_NOT_FOUND'})
    await expect(atualizarCondicaoMarca(db,{...base,motivo:'',expectedRevision:3,idempotencyKey:'reason'})).rejects.toMatchObject({code:'REASON_REQUIRED'})
    await expect(atualizarCondicaoMarca(db,{...base,proposta:{inicio_vigencia:'2026-04'},expectedRevision:3,idempotencyKey:'start'})).rejects.toMatchObject({code:'IMMUTABLE_START'})
    expect(await revision()).toBe(3)
  })
  it('late audit failure rolls back condition, title marker and open projections', async () => {
    const failing={query:async(sql,params)=>{if(sql.startsWith('INSERT INTO audit_log')) throw new Error('audit failure');return db.query(sql,params)}}
    await expect(excluirCondicaoMarca(failing,{...base,expectedRevision:3,idempotencyKey:'rollback'})).rejects.toThrow('audit failure')
    expect(await revision()).toBe(3)
    expect(await months()).toEqual([100,100,200,200,300,300])
    expect((await db.query('SELECT count(*)::int AS n FROM receita_titulos WHERE suspensao_comercial IS NOT NULL')).rows[0].n).toBe(0)
  })
  it('recreating April fills only that gap and reuses the paid April title', async () => {
    await excluirCondicaoMarca(db,{...base,expectedRevision:3,idempotencyKey:'march'})
    const recreated=await confirmarCondicaoMarca(db,{...base,expectedRevision:4,idempotencyKey:'april',
      proposta:{inicio_vigencia:'2026-04',fixo_mensal:250,comissao_franquia_pct:12,fixo_confirmado:true,comissao_confirmada:true,motivo:'Retomada'}})
    expect(recreated.condition.revision).toBe(5)
    expect(await months()).toEqual([100,100,0,250,300,300])
    const title=(await db.query('SELECT id,valor_previsto::text AS previsto,valor_pago::text AS pago,suspensao_comercial FROM receita_titulos WHERE id=$1',[id(22)])).rows[0]
    expect(title).toEqual({id:id(22),previsto:'250.00',pago:'200.00',suspensao_comercial:null})
    expect((await db.query('SELECT comissao_calculada::text AS n FROM lives WHERE id=$1',[id(32)])).rows[0].n).toBe('100.00')
  })
  it('same-month recreation supersedes canceled revision, keeps old row and global revision', async () => {
    await excluirCondicaoMarca(db,{...base,expectedRevision:3,idempotencyKey:'march'})
    const args={...base,expectedRevision:4,idempotencyKey:'march-again',
      proposta:{inicio_vigencia:'2026-03',fixo_mensal:220,fixo_confirmado:true,comissao_confirmada:true}}
    const recreated=await confirmarCondicaoMarca(db,args)
    expect(recreated.condition.revision).toBe(5)
    expect(await months()).toEqual([100,100,220,220,300,300])
    const history=await listarCondicoesMarca(db,base)
    expect(history.filter(r=>r.competencia==='2026-03')).toHaveLength(2)
    expect(resolveMarcaCondicao(history,'2026-04-15').id).toBe(recreated.condition.id)
    expect((await confirmarCondicaoMarca(db,args)).idempotent).toBe(true)
  })
  it('consecutive cancellation never resurrects earlier conditions', async () => {
    await excluirCondicaoMarca(db,{...base,expectedRevision:3,idempotencyKey:'march'})
    await excluirCondicaoMarca(db,{...base,condicaoId:may,expectedRevision:4,idempotencyKey:'may'})
    expect(await months()).toEqual([100,100,0,0,0,0])
    expect(await revision()).toBe(5)
  })
})
