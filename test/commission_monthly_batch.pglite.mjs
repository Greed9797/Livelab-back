// Real SQL regression: batch preserves the individual commission resolver.
import assert from 'node:assert/strict'
import { recalcularVendasAtribuidasApresentadora, calcularComissoesAtribuidas } from '../src/routes/vendas_atribuidas.js'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
await db.exec(`
CREATE TABLE marcas(id uuid,tenant_id uuid,comissao_franquia_pct numeric,comissao_franqueadora_pct numeric);
CREATE TABLE apresentadora_comissao_faixas(tenant_id uuid,apresentadora_id uuid,ativo boolean,gmv_inicio numeric,gmv_fim numeric,comissao_pct numeric);
CREATE TABLE tenant_comissao_faixas_default(tenant_id uuid,gmv_inicio numeric,gmv_fim numeric,comissao_pct numeric);
CREATE TABLE vendas_atribuidas(id uuid PRIMARY KEY,tenant_id uuid,apresentadora_id uuid,marca_id uuid,origem text,origem_id uuid,data date,gmv numeric,pedidos int,status_aprovacao text,comissao_apresentadora numeric DEFAULT 99,comissao_franquia numeric DEFAULT 99,comissao_franqueadora numeric DEFAULT 99,atualizado_em timestamptz,criado_em timestamptz DEFAULT now());
CREATE TABLE lives(id uuid,tenant_id uuid,comissao_apresentadora_valor numeric,comissao_apresentadora_pct numeric);
`)
await db.query('INSERT INTO marcas VALUES ($1,$2,10,2)', [id(3),id(1)])
await db.query('INSERT INTO apresentadora_comissao_faixas VALUES ($1,$2,true,0,1000,1),($1,$2,true,1000,null,3)',[id(1),id(2)])
await db.query('INSERT INTO tenant_comissao_faixas_default VALUES ($1,0,null,1.5)',[id(1)])
for(let n=0;n<84;n++) {
 const origin=n===0?'live':'video'; const date=n===0?'2026-08-02':'2026-08-03'
 await db.query(`INSERT INTO vendas_atribuidas(id,tenant_id,apresentadora_id,marca_id,origem,origem_id,data,gmv,pedidos,status_aprovacao) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`,[id(100+n),id(1),id(2),id(3),origin,id(200+n),date,n===5?0:100,n===1?'aprovada':n===2?'rejeitada':null])
}
// Other tenant/month and same-origin duplicate must not change exclusion semantics.
await db.query(`INSERT INTO vendas_atribuidas(id,tenant_id,apresentadora_id,marca_id,origem,origem_id,data,gmv,status_aprovacao) VALUES ($1,$2,$3,$4,'video',$5,'2026-08-03',450,'aprovada'),($6,$7,$3,$4,'video',$8,'2026-08-03',999999,'pendente_aprovacao'),($9,$2,$3,$4,'video',$10,'2026-07-03',999999,'pendente_aprovacao')`,[id(500),id(1),id(2),id(3),id(203),id(501),id(9),id(601),id(502),id(602)])
await db.query('INSERT INTO lives VALUES($1,$2,null,null)',[id(200),id(1)])
for(const mode of ['presenter','tenant','code']) {
 if(mode==='tenant')await db.exec('DELETE FROM apresentadora_comissao_faixas')
 if(mode==='code')await db.exec('DELETE FROM tenant_comissao_faixas_default')
 const before=(await db.query('SELECT * FROM vendas_atribuidas ORDER BY id')).rows
 const expected=new Map()
 for(const v of before.filter(v=>v.tenant_id===id(1)&&new Date(v.data).toISOString().startsWith('2026-08')&&(v.status_aprovacao??'pendente_aprovacao')==='pendente_aprovacao')) {
  expected.set(v.id,await calcularComissoesAtribuidas(db,{tenantId:id(1),apresentadoraId:id(2),marcaId:v.marca_id,origem:v.origem,origemId:v.origem_id,data:v.data,gmv:v.gmv}))
 }
 let queries=0
 await db.exec('BEGIN')
 const result=await recalcularVendasAtribuidasApresentadora({query:async(...args)=>{queries++;return db.query(...args)}},{tenantId:id(1),apresentadoraId:id(2),mesReferencia:'2026-08'})
 assert.equal(result.updated,expected.size);assert.equal(queries,5)
 const after=(await db.query('SELECT * FROM vendas_atribuidas ORDER BY id')).rows
 for(const row of after) {
  const target=expected.get(row.id)
  if(target) for(const key of Object.keys(target))assert(Math.abs(Number(row[key])-target[key])<1e-9,`${mode} ${row.id} ${key}`)
  else assert.deepEqual(row,before.find(v=>v.id===row.id))
 }
 assert.equal(Number((await db.query('SELECT comissao_apresentadora_valor FROM lives')).rows[0].comissao_apresentadora_valor),2)
 await db.exec('ROLLBACK')
}
// Approval between read and write must win, even with a stale batch payload.
await db.exec('BEGIN')
await recalcularVendasAtribuidasApresentadora({query:async(sql,params)=>{
 if(sql.startsWith('UPDATE vendas_atribuidas va')) {
  await db.query("UPDATE vendas_atribuidas SET status_aprovacao='aprovada' WHERE id=$1",[id(103)])
 }
 return db.query(sql,params)
}},{tenantId:id(1),apresentadoraId:id(2),mesReferencia:'2026-08'})
assert.equal(Number((await db.query('SELECT comissao_apresentadora FROM vendas_atribuidas WHERE id=$1',[id(103)])).rows[0].comissao_apresentadora),99)
await db.exec('ROLLBACK')
// A failed snapshot must allow the caller transaction to roll back the entire batch.
await db.exec('BEGIN')
await assert.rejects(recalcularVendasAtribuidasApresentadora({query:async(sql,params)=>{
 if(sql.startsWith('UPDATE lives l'))throw new Error('snapshot failure')
 return db.query(sql,params)
}},{tenantId:id(1),apresentadoraId:id(2),mesReferencia:'2026-08'}),/snapshot failure/)
await db.exec('ROLLBACK')
assert.equal(Number((await db.query('SELECT comissao_apresentadora FROM vendas_atribuidas WHERE id=$1',[id(103)])).rows[0].comissao_apresentadora),99)
await db.close()
console.log('PASS: real SQL matches legacy resolver; weekend, all fallback tiers, zero GMV, approved/rejected, duplicate origin, tenant/month isolation, snapshot; 5 queries for 82 pending sales')
