import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { analyticsOperacionalRoutes, parseOperationalQuery } from '../src/routes/analytics-operacional.js'
import { buildOperationalRange } from '../src/lib/operational-goals.js'

const now = new Date('2026-10-07T02:00:00Z') // still October 6 in São Paulo
const config={horas_por_apresentador:5,cabines_consideradas:2,turnos:[{inicio:'08:00',fim:'18:00'}],equipe_referencia:['a','b']}
const base={from:'2026-09-30',to:'2026-10-06',now,canManage:true,config,goals:{meta_gmv:22000,meta_gmv_hora:100},
  competencies:[{ano_mes:'2026-09',configuracao_operacional:null},{ano_mes:'2026-10',configuracao_operacional:config}],
  presenters:[{id:'a',nome:'Ana',ativo:true},{id:'b',nome:'Bia',ativo:true}],brands:[{id:'m',nome:'Marca',status:'ativa'}],
  lives:[{id:'1',dia:'2026-09-30',status:'encerrada',marca_id:'m',gmv:100,horas:1},{id:'2',dia:'2026-10-06',status:'encerrada',marca_id:'m',gmv:900,horas:3}],
  credits:[{live_id:'1',apresentadora_id:'a',gmv:100,horas_presenca:1},{live_id:'2',apresentadora_id:'a',gmv:600,horas_presenca:3},{live_id:'2',apresentadora_id:'b',gmv:300,horas_presenca:3}],
  videos:[{dia:'2026-10-06',marca_id:'m',apresentadora_id:'b',gmv:100,status_aprovacao:'aprovada'},{dia:'2026-10-06',gmv:9999,status_aprovacao:'pendente_aprovacao'}],pending:[{dia:'2026-10-06',marca_id:'m',apresentadora_id:'b',tipo:'video'}],
}

describe('strict operational period input',()=>{
  it.each([{}, {from:'' ,to:'2026-10-06'},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-10-06',to:'2026-10-05'},{from:'2026-10-06',to:'2026-10-07'},{data:'2026-10-06',from:'2026-10-06'},{data:'2026-10-06',extra:'x'},{from:'2026-10-06',to:'2026-10-06',marca_id:''},{from:'2025-10-05',to:'2026-10-06'},{data:'2026-13-01'},{from:['2026-10-06'],to:'2026-10-06'}])('rejects invalid request %j',query=>expect(parseOperationalQuery(query,now).error).toBeTruthy())
  it('accepts inclusive 366 days and the São Paulo calendar date',()=>{
    expect(parseOperationalQuery({from:'2025-10-06',to:'2026-10-06'},now).error).toBeUndefined()
    expect(parseOperationalQuery({data:'2026-10-06'},now).legacy).toBe(true)
  })
  it('rejects unknown keys before Fastify can silently strip them',async()=>{
    const app=Fastify()
    app.decorate('requirePapel',()=>async r=>{r.user={tenant_id:'tenant',papel:'gerente'}})
    app.decorate('withTenant',vi.fn())
    await app.register(analyticsOperacionalRoutes)
    const response=await app.inject('/v1/analytics/operacao?data=2020-01-01&unexpected=true')
    expect(response.statusCode).toBe(400)
    expect(app.withTenant).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('operational interval aggregation',()=>{
  it.each([7,30])('sums the complete %i-day range across months using compatible totals',days=>{
    const from=days===7?'2026-09-30':'2026-09-07'
    const payload=buildOperationalRange({...base,from})
    expect(payload.serie).toHaveLength(days)
    expect(payload.resumo).toMatchObject({gmv:1100,gmv_lives:1000,gmv_videos:100,horas_apresentadoras:7,horas_cabines:4,gmv_hora:142.86,lives:2,status:'indisponivel'})
    expect(payload.marcas[0]).toMatchObject({gmv:1000,horas:4,gmv_hora:250})
    expect(payload.apresentadoras[0]).toMatchObject({gmv:700,horas:4,gmv_hora:175})
    expect(payload.contexto_mensal).toMatchObject({ano_mes:'2026-10',corte:'2026-10-06',escopo:'unidade',dados:{gmv:{realizado_mes:1000}}})
    expect(payload.competencias.map(c=>c.configurado)).toEqual([false,true])
    expect(payload.pendencias.videos).toBe(1)
  })
  it('applies presenter and brand filters to shares, videos, pending and details; keeps monthly context unfiltered',()=>{
    const payload=buildOperationalRange({...base,apresentadoraId:'b',marcaId:'m'})
    expect(payload.resumo).toMatchObject({gmv:400,gmv_lives:300,gmv_videos:100,horas_apresentadoras:3,horas_cabines:3,gmv_hora:100,lives:1})
    expect(payload.apresentadoras.map(p=>p.id)).toEqual(['b'])
    expect(payload.marcas[0].lives.map(l=>l.id)).toEqual(['2'])
    expect(payload.marcas[0].lives[0].gmv).toBe(300)
    expect(payload.contexto_mensal.dados.gmv.realizado_mes).toBe(1000)
    expect(buildOperationalRange({...base,apresentadoraId:'a'}).pendencias.videos).toBe(0)
    expect(buildOperationalRange({...base,marcaId:'other'}).resumo.lives).toBe(0)
  })
  it('keeps unknown values null and never classifies incomplete or zero-hour people negatively',()=>{
    const payload=buildOperationalRange({...base,goals:{},config:null,lives:[{...base.lives[0],tempo_incompleto:true,gmv_incompleto:true}],videos:[{...base.videos[0],gmv:null}]})
    expect(payload.resumo).toMatchObject({gmv:null,gmv_lives:null,gmv_videos:null,horas_apresentadoras:null,horas_cabines:null,gmv_hora:null,status:'indisponivel',dados_incompletos:{gmv:true,horas:true}})
    expect(payload.apresentadoras.every(p=>p.status==='indisponivel')).toBe(true)
    expect(buildOperationalRange({...base,lives:[],credits:[],videos:[]}).resumo).toMatchObject({gmv:0,lives:0,gmv_hora:null})
  })
  it('marks pending source values as partial per day/entity without adding unapproved money or hours',()=>{
    const pending=[
      {dia:'2026-09-30',marca_id:'m',apresentadora_id:'a',live_oficial_id:'1',gmv_declarado:9999},
      {dia:'2026-10-06',marca_id:'m',apresentadora_id:'b',tipo:'video',gmv:9999},
    ]
    const payload=buildOperationalRange({...base,pending})
    expect(payload.resumo).toMatchObject({gmv:1100,horas_apresentadoras:7,status:'indisponivel',dados_incompletos:{gmv:true,horas:true}})
    expect(payload.serie.find(d=>d.dia==='2026-09-30')).toMatchObject({gmv:100,dados_incompletos:{gmv:true,horas:true}})
    expect(payload.serie.find(d=>d.dia==='2026-10-06')).toMatchObject({gmv:1000,dados_incompletos:{gmv:true,horas:false}})
    expect(payload.serie.find(d=>d.dia==='2026-10-01').dados_incompletos).toEqual({gmv:false,horas:true})
    expect(payload.apresentadoras.find(p=>p.id==='a')).toMatchObject({gmv:700,dados_incompletos:{gmv:true,horas:true}})
    expect(payload.apresentadoras.find(p=>p.id==='b')).toMatchObject({gmv:300,dados_incompletos:{gmv:true,horas:false}})
    expect(payload.apresentadoras.find(p=>p.id==='a').lives.find(l=>l.id==='1')).toMatchObject({gmv:100,horas:1,dados_incompletos:{gmv:true,horas:true}})
    // Same person/brand/day is not a proven live link: only the explicit ID affects its detail.
    expect(payload.apresentadoras.find(p=>p.id==='b').lives[0].dados_incompletos).toEqual({gmv:false,horas:false})
    expect(payload.marcas[0].dados_incompletos).toEqual({gmv:true,horas:true})
  })
  it('does not leak another entity pending flags into filtered totals, series or details',()=>{
    const payload=buildOperationalRange({...base,apresentadoraId:'a',marcaId:'m'})
    expect(payload.resumo.dados_incompletos).toEqual({gmv:false,horas:false})
    expect(payload.serie.every(d=>!d.dados_incompletos.gmv)).toBe(true)
    expect(payload.serie.find(d=>d.dia==='2026-09-30').dados_incompletos.horas).toBe(false)
    expect(payload.serie.find(d=>d.dia==='2026-10-01').dados_incompletos.horas).toBe(true)
    expect(payload.apresentadoras.every(p=>!p.dados_incompletos.gmv)).toBe(true)
    expect(payload.marcas[0].dados_incompletos.gmv).toBe(false)
    const other=buildOperationalRange({...base,marcaId:'other'})
    expect(other.resumo.dados_incompletos).toEqual({gmv:false,horas:true})
    expect(other.resumo.horas_apresentadoras).toBeNull()
  })
  it('does not count uncredited hours as known zero and redacts restricted monthly goals',()=>{
    const payload=buildOperationalRange({...base,credits:[],canManage:false})
    expect(payload.resumo.horas_apresentadoras).toBeNull()
    expect(payload.contexto_mensal.dados).toMatchObject({pode_editar:false,editavel:false,configuracao:null,gmv:{meta_mensal:null,status:'sem_permissao'}})
    expect(payload.consolidavel).toBe(false)
  })
})
