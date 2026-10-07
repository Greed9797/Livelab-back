import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyticsOperacionalRoutes } from '../src/routes/analytics-operacional.js'

const tenant='11111111-1111-4111-8111-111111111111',brand='22222222-2222-4222-8222-222222222222',ana='33333333-3333-4333-8333-333333333333',bia='44444444-4444-4444-8444-444444444444'
const db=new PGlite(),app=Fastify()
let queryCount=0
beforeAll(async()=>{
  await db.exec(`
    CREATE TABLE tenants(id uuid,meta_diaria_gmv numeric);
    CREATE TABLE meta_unidade(tenant_id uuid,ano_mes text,meta_gmv numeric,meta_horas_live numeric,meta_gmv_hora numeric,configuracao_operacional jsonb);
    CREATE TABLE apresentadoras(id uuid,tenant_id uuid,user_id uuid,nome text,ativo boolean,arquivada boolean);
    CREATE TABLE metas_apresentadora(tenant_id uuid,apresentadora_id uuid,mes_referencia date,meta_gmv_hora numeric);
    CREATE TABLE marcas(id uuid,tenant_id uuid,nome text,status text);
    CREATE TABLE marca_metas_hora(tenant_id uuid,marca_id uuid,ano_mes text,meta_gmv_hora numeric);
    CREATE TABLE cabines(id uuid,tenant_id uuid,numero integer,status text);
    CREATE TABLE lives(id uuid,tenant_id uuid,status text,iniciado_em timestamptz,encerrado_em timestamptz,previsto_fim timestamptz,apresentador_id uuid,uniao_destino_id uuid,uniao_desfeita_em timestamptz,arquivada_em timestamptz,ads_gmv numeric,manual_gmv numeric,fat_gerado numeric,marca_id uuid,cabine_id uuid,agenda_evento_id uuid);
    CREATE TABLE live_apresentadoras_v2(live_id uuid,tenant_id uuid,apresentadora_id uuid,gmv_rateado numeric,percentual_rateio numeric,papel text,segundos_rateio integer);
    CREATE TABLE agenda_evento_apresentadoras(agenda_evento_id uuid,tenant_id uuid,apresentadora_id uuid,data_inicio timestamptz,data_fim timestamptz);
    CREATE TABLE vendas_atribuidas(tenant_id uuid,data date,gmv numeric,status_aprovacao text,origem text,marca_id uuid,apresentadora_id uuid);
    CREATE TABLE apresentadora_live_submissoes(id uuid,live_oficial_id uuid,tenant_id uuid,apresentadora_id uuid,marca_id uuid,gmv_declarado numeric,iniciado_em timestamptz,status text);
  `)
  await db.query("SELECT set_config('app.tenant_id',$1,false)",[tenant])
  await db.query("INSERT INTO apresentadoras VALUES($1,$3,NULL,'Ana',true,false),($2,$3,NULL,'Bia',true,false)",[ana,bia,tenant])
  await db.query("INSERT INTO marcas VALUES($1,$2,'Marca','ativa')",[brand,tenant])
  // First timestamp is Sep 30 locally although the UTC calendar already reads October.
  for(const [index,start,end,gmv] of [[1,'2026-10-01 01:00Z','2026-10-01 02:00Z',100],[2,'2026-10-06 12:00Z','2026-10-06 15:00Z',900]]) {
    const id=`55555555-5555-4555-8555-55555555555${index}`
    await db.query("INSERT INTO lives(id,tenant_id,status,iniciado_em,encerrado_em,ads_gmv,marca_id) VALUES($1,$2,'encerrada',$3,$4,$5,$6)",[id,tenant,start,end,gmv,brand])
    await db.query("INSERT INTO live_apresentadoras_v2 VALUES($1,$2,$3,$5,50,'principal',$6),($1,$2,$4,$5,50,'apoio',$6)",[id,tenant,ana,bia,gmv/2,index===1?3600:10800])
  }
  await db.query("INSERT INTO vendas_atribuidas VALUES($1,'2026-10-06',100,'aprovada','video',$2,$3),($1,'2026-10-06',9999,'pendente_aprovacao','video',$2,$3)",[tenant,brand,bia])
  app.decorate('requirePapel',()=>async request=>{request.user={tenant_id:tenant,papel:'gerente'}})
  app.decorate('withTenant',async(_,fn)=>fn({query:async(...args)=>{queryCount++;return db.query(...args)}}))
  await app.register(analyticsOperacionalRoutes)
},30000)
afterAll(async()=>{await app.close();await db.close()})

describe('operational range actual PostgreSQL route queries',()=>{
  it('batches a 30-day cross-month interval, preserving fanout and unique live GMV',async()=>{
    queryCount=0
    const response=await app.inject('/v1/analytics/operacao?from=2026-09-07&to=2026-10-06')
    expect(response.statusCode).toBe(200)
    const body=response.json()
    expect(body.resumo).toMatchObject({gmv:1100,gmv_lives:1000,gmv_videos:100,horas_apresentadoras:8,horas_cabines:4,gmv_hora:125,lives:2})
    expect(body.serie).toHaveLength(30)
    expect(body.serie.find(d=>d.dia==='2026-09-30').gmv).toBe(100)
    expect(body.contexto_mensal.dados.gmv.realizado_mes).toBe(1000)
    expect(body.pendencias.videos).toBe(1)
    expect(body.resumo.dados_incompletos).toEqual({gmv:true,horas:false})
    expect(queryCount).toBe(11)
  })
  it('filters shares and video attribution while leaving monthly unit context intact',async()=>{
    const response=await app.inject(`/v1/analytics/operacao?from=2026-09-30&to=2026-10-06&marca_id=${brand}&apresentadora_id=${ana}`)
    expect(response.statusCode).toBe(200)
    const body=response.json()
    expect(body.resumo).toMatchObject({gmv:500,gmv_videos:0,horas_apresentadoras:4,horas_cabines:4,lives:2,gmv_hora:125})
    expect(body.pendencias.videos).toBe(0)
    expect(body.resumo.dados_incompletos).toEqual({gmv:false,horas:false})
    expect(body.apresentadoras.map(p=>p.id)).toEqual([ana])
    expect(body.marcas[0].lives.map(l=>l.gmv)).toEqual([50,450])
    expect(body.contexto_mensal.dados.gmv.realizado_mes).toBe(1000)
  })
  it('keeps the daily response exact for the legacy consumer and an unfiltered one-day range',async()=>{
    const legacy=await app.inject('/v1/analytics/operacao?data=2026-10-06')
    const range=await app.inject('/v1/analytics/operacao?from=2026-10-06&to=2026-10-06')
    expect(legacy.statusCode).toBe(200)
    expect(range.json()).toEqual(legacy.json())
    expect(range.json().tipo).toBeUndefined()
    const filtered=await app.inject(`/v1/analytics/operacao?from=2026-10-06&to=2026-10-06&apresentadora_id=${bia}`)
    expect(filtered.json()).toMatchObject({tipo:'intervalo',resumo:{gmv:550,lives:1}})
  })
})
