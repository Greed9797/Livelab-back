// Disposable PostgreSQL/PGlite HTTP integration. Never connects to production.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { portalApresentadoraRoutes } from '../src/routes/portal_apresentadora.js'
import { withPortalPresenterDb } from '../src/services/portal-apresentadora-db.js'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const tenant=id(1), otherTenant=id(2), user=id(3), peer=id(4), manager=id(5), presenter=id(6), peerPresenter=id(7), brand=id(8), cabin=id(9), client=id(10)
await db.exec(`
 SET TIME ZONE 'UTC';
 CREATE TABLE tenants(id uuid PRIMARY KEY);
 CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid,ativo boolean DEFAULT true,papel text);
 CREATE TABLE apresentadoras(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,nome text,ativo boolean DEFAULT true,arquivada boolean DEFAULT false,fixo numeric DEFAULT 2700,foto_url text,comissao_pct numeric);
 CREATE TABLE clientes(id uuid PRIMARY KEY,tenant_id uuid,status text);
 CREATE TABLE contratos(id uuid PRIMARY KEY,tenant_id uuid,status text,comissao_pct numeric);
 CREATE TABLE marcas(id uuid PRIMARY KEY,tenant_id uuid,cliente_id uuid,nome text,status text,tipo text,criado_em timestamptz DEFAULT now(),comissao_franquia_pct numeric DEFAULT 5,comissao_franqueadora_pct numeric DEFAULT 1,valor_fixo_minimo numeric DEFAULT 0);
 CREATE TABLE cabines(id uuid PRIMARY KEY,tenant_id uuid,nome text,numero int,ativo boolean DEFAULT true,contrato_id uuid);
 CREATE TABLE lives(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,cabine_id uuid,cliente_id uuid,apresentador_id uuid,gestor_id uuid,status text,iniciado_em timestamptz,encerrado_em timestamptz,previsto_fim timestamptz,fat_gerado numeric,final_orders_count int,resumo text,tipo text,status_publicacao text,origem_dados text,marca_id uuid,comissao_calculada numeric,comissao_apresentadora_pct numeric,comissao_apresentadora_valor numeric,agenda_evento_id uuid,ads_gmv numeric,manual_gmv numeric,manual_orders int);
 CREATE TABLE live_apresentadores(tenant_id uuid,live_id uuid,apresentador_id uuid);
 CREATE TABLE live_apresentadoras_v2(tenant_id uuid,live_id uuid,apresentadora_id uuid,papel text DEFAULT 'principal',gmv_rateado numeric,segundos_rateio numeric,percentual_rateio numeric,UNIQUE(live_id,apresentadora_id));
 CREATE TABLE apresentadora_marcas(tenant_id uuid,apresentadora_id uuid,marca_id uuid,ativo boolean DEFAULT true);
 CREATE TABLE agenda_eventos(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,tipo text,marca_id uuid,cabine_id uuid,apresentadora_id uuid,data_inicio timestamptz,data_fim timestamptz,status text,live_id uuid,observacoes text,criado_por uuid,atualizado_em timestamptz);
 CREATE TABLE agenda_evento_apresentadoras(tenant_id uuid,agenda_evento_id uuid,apresentadora_id uuid,data_inicio timestamptz,data_fim timestamptz);
 CREATE TABLE vendas_atribuidas(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,origem text,origem_id uuid,marca_id uuid,apresentadora_id uuid,data date,gmv numeric,pedidos int,comissao_apresentadora numeric,comissao_franquia numeric,comissao_franqueadora numeric,status_aprovacao text,status_motivo text,atualizado_em timestamptz,criado_em timestamptz DEFAULT now());
 CREATE UNIQUE INDEX va_key ON vendas_atribuidas(tenant_id,origem,origem_id,COALESCE(apresentadora_id,'00000000-0000-0000-0000-000000000000'::uuid));
 CREATE TABLE apresentadora_comissao_faixas(tenant_id uuid,apresentadora_id uuid,ativo boolean,gmv_inicio numeric,gmv_fim numeric,comissao_pct numeric);
 CREATE TABLE tenant_comissao_faixas_default(tenant_id uuid,ativo boolean,gmv_inicio numeric,gmv_fim numeric,comissao_pct numeric);
 CREATE TABLE apresentadora_fixo_historico(id uuid,tenant_id uuid,apresentadora_id uuid,vigencia_inicio date,valor numeric);
 CREATE TABLE video_registros(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,marca_id uuid,apresentadora_id uuid,data date,gmv_atribuido numeric,pedidos_atribuidos int);
 ALTER TABLE marcas ADD COLUMN logo_url text, ADD COLUMN site text;
 ALTER TABLE clientes ADD COLUMN logo_url text;
 ALTER TABLE contratos ADD COLUMN cliente_id uuid;
`)
await db.exec(await readFile(new URL('../migrations/144_portal_apresentadora_submissoes.sql',import.meta.url),'utf8'))
await db.exec(await readFile(new URL('../migrations/145_portal_apresentadora_runtime_role.sql',import.meta.url),'utf8'))
await db.query(`INSERT INTO tenants VALUES ($1),($2)`,[tenant,otherTenant])
await db.query(`INSERT INTO users(id,tenant_id,papel) VALUES ($1,$4,'apresentadora'),($2,$4,'apresentadora'),($3,$4,'gerente')`,[user,peer,manager,tenant])
await db.query(`INSERT INTO apresentadoras(id,tenant_id,user_id,nome,fixo) VALUES ($1,$3,$4,'Ana',2850),($2,$3,$5,'Bia',3000)`,[presenter,peerPresenter,tenant,user,peer])
await db.query(`INSERT INTO clientes VALUES ($1,$2,'ativo')`,[client,tenant])
await db.query(`INSERT INTO marcas(id,tenant_id,cliente_id,nome,status,tipo) VALUES ($1,$2,$3,'Aurora','ativa','cliente')`,[brand,tenant,client])
await db.query(`INSERT INTO cabines(id,tenant_id,nome,numero) VALUES($1,$2,'Norte',1)`,[cabin,tenant])
await db.query(`INSERT INTO apresentadora_marcas VALUES($1,$2,$4,true),($1,$3,$4,true)`,[tenant,presenter,peerPresenter,brand])
let failAudit=false, failCommit=false
const app=Fastify()
// Synthetic trusted identity stands in for JWT verification; database linkage,
// role revocation, RLS and every route's SQL remain real and are exercised below.
app.decorate('authenticate',async request=>{request.user={tenant_id:request.headers['x-test-tenant']||tenant,sub:request.headers['x-test-user']||user,papel:request.headers['x-test-role']||'apresentadora'}})
app.decorate('requirePapel',roles=>async(request,reply)=>{if(!roles.includes(request.user.papel))return reply.code(403).send({error:'forbidden'})})
const portalClient={
 query:async(sql,params)=>{if(failCommit && sql==='COMMIT'){failCommit=false;return db.query('SELECT 1/0')}if(failAudit && sql.includes('INSERT INTO apresentadora_live_submissao_historico')){failAudit=false;return db.query('SELECT 1/0')}const result=await db.query(sql,params)
 // Match src/lib/pg-date-string.js: application pg returns DATE as YYYY-MM-DD.
 for(const field of result.fields??[])if(field.dataTypeID===1082)for(const row of result.rows)if(row[field.name] instanceof Date)row[field.name]=row[field.name].toISOString().slice(0,10)
 return result},
 release:()=>{},
}
app.decorate('db',{pool:{connect:async()=>portalClient}})
// Prove the real migration role, policy and transaction-local cleanup before
// exercising HTTP. This deliberately uses the same pooled client the routes use.
await db.query(`INSERT INTO apresentadora_live_submissoes (tenant_id,apresentadora_id,marca_descricao,iniciado_em,encerrado_em)
  VALUES ($1,$2,'Outra unidade','2026-09-01T12:00:00Z','2026-09-01T13:00:00Z')`,[otherTenant,presenter])
const roleProof=await withPortalPresenterDb(app,tenant,async portalDb=>{
 const who=await portalDb.query(`SELECT current_user AS role, current_setting('app.tenant_id',true) AS tenant_id`)
 assert.equal(who.rows[0].role,'livelab_portal_runtime');assert.equal(who.rows[0].tenant_id,tenant)
 const visible=await portalDb.query('SELECT count(*)::int AS n FROM apresentadora_live_submissoes')
 assert.equal(visible.rows[0].n,0)
 return who.rows[0]
})
assert.equal(roleProof.role,'livelab_portal_runtime')
await assert.rejects(withPortalPresenterDb(app,tenant,portalDb=>portalDb.query(`INSERT INTO apresentadora_live_submissoes (tenant_id,apresentadora_id,marca_descricao,iniciado_em,encerrado_em)
  VALUES ($1,$2,'Tentativa externa','2026-09-02T12:00:00Z','2026-09-02T13:00:00Z')`,[otherTenant,presenter])))
const resetProof=(await db.query(`SELECT current_user AS role, current_setting('app.tenant_id',true) AS tenant_id`)).rows[0]
assert.notEqual(resetProof.role,'livelab_portal_runtime');assert.notEqual(resetProof.tenant_id,tenant)
process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST=tenant
await app.register(portalApresentadoraRoutes)
const headers={'x-test-user':manager,'x-test-role':'gerente'}
const inject=(method,url,payload,extra={})=>app.inject({method,url,...(payload===undefined?{}:{payload}),...extra})
const own='/v1/portal/apresentadora/submissoes',review='/v1/lives/submissoes-apresentadoras'
const payload={marca_id:brand,cabine_id:cabin,iniciado_em:'2026-09-05T12:00:00Z',encerrado_em:'2026-09-05T14:00:00Z',gmv_declarado:200,pedidos_declarados:2,request_id:id(11)}
const counts=async()=> (await db.query(`SELECT (SELECT count(*)::int FROM lives) AS lives,(SELECT count(*)::int FROM vendas_atribuidas) AS sales,(SELECT count(*)::int FROM apresentadora_live_submissoes WHERE tenant_id='${tenant}'::uuid) AS submissions,(SELECT count(*)::int FROM apresentadora_live_submissao_historico WHERE tenant_id='${tenant}'::uuid) AS history`)).rows[0]
const check=(r,status)=>{assert.equal(r.statusCode,status,r.body);return r.json()}
try {
 failAudit=true;check(await inject('POST',own,payload),500)
 assert.deepEqual(await counts(),{lives:0,sales:0,submissions:0,history:0})
 failCommit=true;check(await inject('POST',own,payload),500)
 assert.deepEqual(await counts(),{lives:0,sales:0,submissions:0,history:0})
 const created=check(await inject('POST',own,payload),201),sid=created.id
 assert.equal(created.status,'pendente');assert.deepEqual(await counts(),{lives:0,sales:0,submissions:1,history:1})
 const replay=check(await inject('POST',own,payload),200);assert.equal(replay.id,sid)
 assert.deepEqual(await counts(),{lives:0,sales:0,submissions:1,history:1})
 check(await inject('POST',own,{...payload,gmv_declarado:201}),409)
 check(await inject('PATCH',`${own}/${sid}`,payload),404)
 check(await inject('POST',`${review}/${sid}/devolver`,{motivo:'Confira os pedidos'}),403)
 failAudit=true;check(await inject('POST',`${review}/${sid}/devolver`,{motivo:'Confira os pedidos'},{headers}),500)
 assert.equal((await db.query('SELECT status FROM apresentadora_live_submissoes WHERE id=$1',[sid])).rows[0].status,'pendente')
 check(await inject('POST',`${review}/${sid}/devolver`,{motivo:'Confira os pedidos'},{headers}),200)
 check(await inject('PATCH',`${own}/${sid}`,{...payload,pedidos_declarados:3},{headers:{'x-test-user':peer}}),404)
 failAudit=true;check(await inject('PATCH',`${own}/${sid}`,{...payload,pedidos_declarados:3}),500)
 assert.equal(Number((await db.query('SELECT pedidos_declarados FROM apresentadora_live_submissoes WHERE id=$1',[sid])).rows[0].pedidos_declarados),2)
 check(await inject('PATCH',`${own}/${sid}`,{...payload,pedidos_declarados:3}),200)
 failAudit=true;check(await inject('POST',`${own}/${sid}/reenviar`),500)
 assert.equal((await db.query('SELECT status FROM apresentadora_live_submissoes WHERE id=$1',[sid])).rows[0].status,'devolvida')
 check(await inject('POST',`${own}/${sid}/reenviar`),200)
 assert.equal((await counts()).lives,0);assert.equal((await counts()).sales,0)
 const official={marca_id:brand,cabine_id:cabin,iniciado_em:payload.iniciado_em,encerrado_em:payload.encerrado_em,gmv_oficial:150,pedidos_oficiais:1}
 check(await inject('POST',`${review}/${sid}/aprovar`,{...official,encerrado_em:'2099-09-05T14:00:00Z'},{headers}),422)
 failAudit=true;check(await inject('POST',`${review}/${sid}/aprovar`,official,{headers}),500)
 assert.equal((await counts()).lives,0);assert.equal((await counts()).sales,0)
 const approved=check(await inject('POST',`${review}/${sid}/aprovar`,official,{headers}),200)
 assert.equal((await counts()).lives,1);assert.equal((await counts()).sales,1)
 const sale=(await db.query('SELECT gmv,pedidos,comissao_apresentadora FROM vendas_atribuidas')).rows[0]
 assert.equal(Number(sale.gmv),150);assert.equal(sale.pedidos,1);assert.equal(Number(sale.comissao_apresentadora),3)
 assert.equal((await db.query('SELECT count(*)::int AS n FROM agenda_eventos')).rows[0].n,1)
 const homeResponse=await inject('GET','/v1/portal/apresentadora/me?mes=2026-09')
 assert.equal(homeResponse.headers['cache-control'],'private, no-store')
 const home=check(homeResponse,200)
 assert.equal(home.remuneracao.fixo,2850);assert.equal(home.desempenho.gmv_lives,150)
 assert.equal(home.desempenho.total_lives,1)
 for(const row of home.ranking){
   for(const key of ['email','cpf_cnpj','telefone','comissao_apresentadora'])assert.equal(Object.hasOwn(row,key),false)
   for(const key of ['fixo','comissao_variavel','total_recebido'])assert.equal(Object.hasOwn(row,key),true)
 }
 const peerHistory=check(await inject('GET','/v1/portal/apresentadora/lives?mes=2026-09',undefined,{headers:{'x-test-user':peer}}),200)
 assert.deepEqual(peerHistory.items,[]);assert.deepEqual(peerHistory.submissoes,[])

 const audit=(await db.query('SELECT acao,snapshot FROM apresentadora_live_submissao_historico ORDER BY criado_em,id')).rows
 assert.equal(audit.length,5);assert.equal(Number(audit.find(r=>r.acao==='criada').snapshot.pedidos_declarados),2);assert.equal(Number(audit.find(r=>r.acao==='editada').snapshot.pedidos_declarados),3)
 const repeated=await inject('POST',`${review}/${sid}/aprovar`,official,{headers});assert.ok([200,409].includes(repeated.statusCode));assert.equal((await counts()).lives,1)
 check(await inject('PATCH',`${own}/${sid}`,payload),404)
 const peerSub=check(await inject('POST',own,{...payload,request_id:id(12)},{headers:{'x-test-user':peer}}),201)
 await db.query(`INSERT INTO live_apresentadoras_v2(tenant_id,live_id,apresentadora_id,papel,percentual_rateio) VALUES($1,$2,$3,'apoio',50)`,[tenant,approved.live_oficial_id,peerPresenter])
 check(await inject('POST',`${review}/${peerSub.id}/aprovar`,{live_id:approved.live_oficial_id},{headers}),200)
 assert.equal((await counts()).lives,1);assert.equal((await counts()).sales,1)
 check(await inject('GET',`${own.replace('/submissoes','/lives')}?mes=2026-13`),400)
 const sameLink=check(await inject('POST',`${review}/${sid}/aprovar`,{live_id:approved.live_oficial_id},{headers}),200)
 assert.equal(sameLink.live_oficial_id,approved.live_oficial_id)
 const cancellation=check(await inject('POST',own,{...payload,request_id:id(13)}),201)
 check(await inject('DELETE',`${own}/${cancellation.id}`),404)
 check(await inject('POST',`${review}/${cancellation.id}/devolver`,{motivo:'Envio duplicado'},{headers}),200)
 failAudit=true;check(await inject('DELETE',`${own}/${cancellation.id}`),500)
 assert.equal((await db.query('SELECT status FROM apresentadora_live_submissoes WHERE id=$1',[cancellation.id])).rows[0].status,'devolvida')
 check(await inject('DELETE',`${own}/${cancellation.id}`,undefined,{headers:{'x-test-user':peer}}),404)
 check(await inject('DELETE',`${own}/${cancellation.id}`),200)
 assert.equal((await db.query('SELECT status FROM apresentadora_live_submissoes WHERE id=$1',[cancellation.id])).rows[0].status,'cancelada')
 assert.equal((await counts()).lives,1);assert.equal((await counts()).sales,1)
 check(await inject('POST',`${own}/${cancellation.id}/reenviar`),404)
 await db.query("UPDATE users SET papel='apresentadora' WHERE id=$1",[manager])
 check(await inject('GET',review,undefined,{headers}),403)
 check(await inject('POST',`${review}/${cancellation.id}/devolver`,{motivo:'stale manager'},{headers}),403)
 await db.query("UPDATE users SET papel='gerente' WHERE id=$1",[manager])
 check(await inject('GET',review,undefined,{headers:{...headers,'x-test-tenant':otherTenant}}),404)
 await db.query("UPDATE users SET ativo=false WHERE id=$1",[user])
 check(await inject('GET','/v1/portal/apresentadora/lives?mes=2026-09'),409)
 console.log(JSON.stringify({passed:true,checks:['HTTP state machine with real SQL','NOBYPASSRLS role','pending isolation','create idempotency','payload mismatch','cross-presenter ownership','audit failure rollback at each transition','official manager values','commission engine and agenda integration','approved immutable','two split submissions one live','month validation','inactive user blocked','fresh manager role','logical cancellation rollback','same-target replay','own fixed and safe ranking','no success before commit'],counts:await counts()}))
} finally {await app.close();await db.close()}
