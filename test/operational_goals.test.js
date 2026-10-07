import { describe, expect, it } from 'vitest'
import { buildOperationalGoals, goalStatus, shiftProgress, validateOperationalConfig } from '../src/lib/operational-goals.js'
import { countWeekdaysInMonth } from '../src/lib/dias_uteis.js'

const config = { horas_por_apresentador: 5.5, cabines_consideradas: 6, turnos: [{ inicio:'08:00', fim:'13:30' },{ inicio:'14:00', fim:'19:30' }], equipe_referencia:[] }
const now = new Date('2026-10-07T15:00:00.000Z') // 12h em São Paulo
const presenters = Array.from({length:10}, (_,i)=>({id:String(i),nome:'Apresentadora '+i,ativo:true}))

describe('Analytics operational goals', () => {
  it('derives 55 presenter-hours, daily GMV and the required live GMV per hour', () => {
    expect(countWeekdaysInMonth(2026,10)).toBe(22)
    const result=buildOperationalGoals({day:'2026-10-07',now,config,goals:{meta_gmv:600000,meta_gmv_hora:300},presenters,brands:[],lives:[],credits:[],videos:[],pending:[]})
    expect(result.horas.meta).toBe(55)
    expect(result.gmv.meta_diaria).toBe(27272.73)
    expect(result.produtividade.necessario).toBe(495.87)
    expect(result.produtividade.potencial_mensal_piso).toBe(363000)
    expect(result.produtividade.piso_sustenta_meta).toBe(false)
    expect(result.capacidade.horas_cabines).toBe(66)
  })

  it('uses the turn schedule for intraday pace and subtracts the break', () => {
    const pace=shiftProgress(config,'2026-10-07',now)
    expect(pace.horas_operacao).toBe(11)
    expect(pace.fracao).toBeCloseTo(4/11)
    expect(shiftProgress(config,'2026-10-10',now).fracao).toBe(0)
  })

  it('keeps person presence separate from the money allocation and orders deficits first', () => {
    const people=[
      {id:'a',nome:'Ana',ativo:true},{id:'b',nome:'Bia',ativo:true},
    ]
    const result=buildOperationalGoals({day:'2026-10-07',now,config:{...config,horas_por_apresentador:2,equipe_referencia:['a','b']},goals:{meta_gmv:44000,meta_gmv_hora:300},presenters:people,brands:[{id:'brand',nome:'Marca',status:'ativa',meta_gmv_hora:500}],lives:[{id:'live',dia:'2026-10-07',status:'encerrada',marca_id:'brand',gmv:0,horas:4}],credits:[{live_id:'live',apresentadora_id:'a',horas_presenca:2,gmv:0},{live_id:'live',apresentadora_id:'b',horas_presenca:2,gmv:0}],videos:[],pending:[]})
    expect(result.apresentadoras.map(p=>p.horas)).toEqual([2,2])
    expect(result.apresentadoras.every(p=>p.status==='abaixo_do_ritmo')).toBe(true)
    expect(result.marcas[0].status).toBe('abaixo_do_ritmo')
    expect(result.horas.realizado).toBe(4)
  })

  it('never treats an open day as a final deficit or missing/under-review metrics as zero', () => {
    expect(goalStatus(40,50,{closed:false})).toBe('abaixo_do_ritmo')
    expect(goalStatus(40,50,{closed:true})).toBe('abaixo_da_meta')
    expect(goalStatus(0,50,{pending:true,closed:true})).toBe('dados_pendentes')
    expect(goalStatus(null,50,{closed:true})).toBe('sem_dados')
  })

  it('keeps intraday pace visible while a live is in progress', () => {
    const result=buildOperationalGoals({day:'2026-10-07',now,config,goals:{meta_gmv:600000,meta_gmv_hora:300},presenters,lives:[{id:'open',dia:'2026-10-07',status:'em_andamento',gmv:2500,horas:2,tempo_incompleto:false,gmv_incompleto:true}],credits:[{live_id:'open',apresentadora_id:'0',gmv:2500,horas_presenca:2}],videos:[],pending:[]})
    expect(result.estado).toBe('em_andamento')
    expect(result.gmv.status).toBe('abaixo_do_ritmo')
    expect(result.gmv.lives).toBe(2500)
    expect(result.horas.realizado).toBe(2)
    expect(result.apresentadoras[0].horas).toBe(2)
  })

  it('shows pending data before a previously consolidated label', () => {
    const result=buildOperationalGoals({day:'2026-10-07',now,config:{...config,dias_consolidados:['2026-10-07']},goals:{meta_gmv:600000,meta_gmv_hora:300},presenters,lives:[{id:'live',dia:'2026-10-07',status:'encerrada',gmv:0,horas:1,tempo_incompleto:false,gmv_incompleto:true}],credits:[],videos:[],pending:[]})
    expect(result.estado).toBe('dados_pendentes')
    expect(result.gmv.status).toBe('dados_pendentes')
  })

  it('excludes unapproved video GMV and keeps the day pending until review', () => {
    const result=buildOperationalGoals({day:'2026-10-07',now,config,goals:{meta_gmv:600000,meta_gmv_hora:300},presenters,brands:[],lives:[],credits:[],videos:[{dia:'2026-10-07',gmv:9000,status_aprovacao:'pendente_aprovacao'},{dia:'2026-10-07',gmv:1200,status_aprovacao:'aprovada'}],pending:[{dia:'2026-10-07',tipo:'video'}]})
    expect(result.gmv.videos).toBe(1200)
    expect(result.gmv.realizado).toBe(1200)
    expect(result.estado).toBe('dados_pendentes')
    expect(result.pendencias.videos).toBe(1)
  })

  it('keeps the configured team target stable after a presenter is deactivated', () => {
    const result=buildOperationalGoals({day:'2026-10-07',now,config:{...config,equipe_referencia:['0','1']},goals:{meta_gmv:600000},presenters:presenters.map((p,i)=>({...p,ativo:i>1})),lives:[],credits:[],videos:[],pending:[]})
    expect(result.horas.meta).toBe(11)
    expect(result.equipe_ativa).toBe(2)
  })

  it('rejects overlapping shifts and invalid capacity settings', () => {
    expect(validateOperationalConfig(config)).toBe(true)
    expect(validateOperationalConfig({...config,turnos:[{inicio:'08:00',fim:'14:00'},{inicio:'13:00',fim:'18:00'}]})).toBe(false)
    expect(validateOperationalConfig({...config,cabines_consideradas:0})).toBe(false)
  })
})
