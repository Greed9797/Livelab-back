import { afterAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { apresentadoraHorasPresencaSql, liveGmvSql } from '../src/lib/metric-sql.js'
import { presenterFanoutSql, presenterGmvShareSql } from '../src/lib/live-count-sql.js'
import { activeLiveSql } from '../src/lib/live-merge-sql.js'

const tenant='11111111-1111-4111-8111-111111111111'
const live='22222222-2222-4222-8222-222222222222'
const ana='33333333-3333-4333-8333-333333333333'
const bia='44444444-4444-4444-8444-444444444444'
const db=new PGlite()

afterAll(async()=>db.close())

describe('operational goals PostgreSQL semantics',()=>{
  it('fans out a revezada live and keeps zero-GMV presenter presence measurable',async()=>{
    await db.exec('CREATE TABLE lives(id uuid PRIMARY KEY,tenant_id uuid,status text,iniciado_em timestamptz,encerrado_em timestamptz,previsto_fim timestamptz,apresentador_id uuid,uniao_destino_id uuid,uniao_desfeita_em timestamptz,arquivada_em timestamptz,ads_gmv numeric,manual_gmv numeric,fat_gerado numeric); CREATE TABLE apresentadoras(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,nome text); CREATE TABLE live_apresentadoras_v2(live_id uuid,tenant_id uuid,apresentadora_id uuid,gmv_rateado numeric,percentual_rateio numeric,papel text,segundos_rateio integer); CREATE TABLE agenda_evento_apresentadoras(agenda_evento_id uuid,tenant_id uuid,apresentadora_id uuid,data_inicio timestamptz,data_fim timestamptz);')
    await db.query('INSERT INTO lives VALUES($1,$2,\'encerrada\',\'2026-10-06 08:00:00-03\',\'2026-10-06 12:00:00-03\',NULL,NULL,NULL,NULL,NULL,0,0,0)',[live,tenant])
    await db.query('INSERT INTO apresentadoras VALUES($1,$3,NULL,$4),($2,$3,NULL,$5)',[ana,bia,tenant,'Ana','Bia'])
    await db.query('INSERT INTO live_apresentadoras_v2 VALUES($1,$2,$3,0,0,\'principal\',7200),($1,$2,$4,0,0,\'apoio\',7200)',[live,tenant,ana,bia])
    const sql='SELECT ap_v2.apresentadora_id,'+apresentadoraHorasPresencaSql()+' AS horas,'+presenterGmvShareSql('l','ap_v2')+' AS gmv '+
      'FROM lives l '+presenterFanoutSql({live:'l',rateio:'ap_v2'})+
      ' JOIN apresentadoras a ON a.id=ap_v2.apresentadora_id AND a.tenant_id=l.tenant_id '+
      'LEFT JOIN LATERAL (SELECT NULL::numeric AS horas_turno) turno ON true '+
      'WHERE l.tenant_id=$1 AND '+activeLiveSql('l')+' AND l.status=\'encerrada\''
    const result=await db.query(sql,[tenant])
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map(r=>Number(r.horas))).toEqual([2,2])
    expect(result.rows.map(r=>Number(r.gmv))).toEqual([0,0])
    const total=await db.query('SELECT '+liveGmvSql('l')+' AS gmv FROM lives l WHERE l.id=$1',[live])
    expect(Number(total.rows[0].gmv)).toBe(0)
  })

  it('uses elapsed time, not the scheduled end, for an active live',async()=>{
    const active='55555555-5555-4555-8555-555555555555'
    await db.query("INSERT INTO lives VALUES($1,$2,'em_andamento','2026-10-07 10:00:00-03',NULL,'2026-10-07 13:30:00-03',NULL,NULL,NULL,NULL,2500,NULL,NULL)",[active,tenant])
    await db.query("INSERT INTO live_apresentadoras_v2 VALUES($1,$2,$3,1250,50,'principal',NULL),($1,$2,$4,1250,50,'apoio',NULL)",[active,tenant,ana,bia])
    const sql='SELECT ap_v2.apresentadora_id,'+apresentadoraHorasPresencaSql({end:"TIMESTAMPTZ '2026-10-07 12:00:00-03'"})+' AS horas,'+presenterGmvShareSql('l','ap_v2')+' AS gmv '+
      'FROM lives l '+presenterFanoutSql({live:'l',rateio:'ap_v2'})+
      ' JOIN apresentadoras a ON a.id=ap_v2.apresentadora_id AND a.tenant_id=l.tenant_id '+
      'LEFT JOIN LATERAL (SELECT NULL::numeric AS horas_turno) turno ON true '+
      "WHERE l.tenant_id=$1 AND l.status='em_andamento' AND l.id=$2 ORDER BY ap_v2.apresentadora_id"
    const result=await db.query(sql,[tenant,active])
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map(r=>Number(r.horas))).toEqual([2,2])
    expect(result.rows.map(r=>Number(r.gmv))).toEqual([1250,1250])
  })
})
