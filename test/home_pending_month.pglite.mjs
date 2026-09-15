// Execute the actual month-selection SQL emitted by the Home route in a
// disposable database. Other dashboard queries are outside this narrow test.
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { homeRoutes } from '../src/routes/home.js'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const tenant = '11111111-1111-4111-8111-111111111111'
await db.exec(`CREATE TABLE lives(tenant_id uuid,iniciado_em timestamptz,status text,ads_gmv numeric,manual_gmv numeric,fat_gerado numeric);
 CREATE TABLE vendas_atribuidas(tenant_id uuid,data timestamptz,origem text,status_aprovacao text,gmv numeric);
 CREATE TABLE apresentadora_live_submissoes(tenant_id uuid,iniciado_em timestamptz,status text,gmv_declarado numeric);
 SELECT set_config('app.tenant_id','${tenant}',false);
 INSERT INTO lives VALUES('${tenant}',date_trunc('month',now())-interval '1 month','encerrada',NULL,NULL,100);
 INSERT INTO apresentadora_live_submissoes VALUES('${tenant}',now()-interval '1 minute','pendente',20);`)
const app = Fastify()
let monthSql
app.decorate('requirePapel',()=>async request=>{request.user={tenant_id:tenant,sub:'manager',papel:'gerente'}})
app.decorate('tenantParallel',()=>({query:async sql=>{
 if(sql.includes('WITH meses AS')) monthSql=sql
 if(sql.includes('mes_corrente')) return {rows:[{mes_corrente:'2026-09',dia:14}]}
 return {rows:[]}
}}))
try {
 await app.register(homeRoutes)
 await app.inject({method:'GET',url:'/v1/home/dashboard'})
 assert.ok(monthSql,'Home must select its default operational month')
 const current=(await db.query(`SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS mes`)).rows[0].mes
 assert.equal((await db.query(monthSql)).rows[0].mes,current,'pending-only current month must not disappear behind a previous official month')
 await db.exec(`UPDATE apresentadora_live_submissoes SET status='devolvida'`)
 assert.notEqual((await db.query(monthSql)).rows[0].mes,current,'returned submissions must not activate an operational month')
 console.log(JSON.stringify({passed:true,checks:['pending-only Home month','returned excluded','real PostgreSQL query']}))
} finally {await app.close();await db.close()}
