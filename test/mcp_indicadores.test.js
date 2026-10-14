import { describe, it, expect } from 'vitest'
import { aggregateFacts, evolution, compareMetrics } from '../src/services/mcp-indicadores.js'
import { periodSchema, toolDefinitions } from '../src/mcp/tools.js'

const facts = [
  { id: 'l1', origem: 'live', dia: '2026-10-01', gmv: 100, pedidos: 2, horas: 4, marca_id: 'm1', cabine_id: 'c1', participantes: [
    { id: 'a1', nome: 'Ana', gmv: 100, pedidos: 2, horas_presenca: 3, horas_produtividade: 4, presenca_estimada: false },
    { id: 'a2', nome: 'Bia', gmv: 0, pedidos: 0, horas_presenca: 1, horas_produtividade: 0, presenca_estimada: false },
  ] },
  { id: 'v1', origem: 'video', dia: '2026-10-02', gmv: 50, pedidos: 1, horas: 0, marca_id: 'm1', cabine_id: null,
    participantes: [{ id: 'a2', nome: 'Bia', gmv: 50, pedidos: 1, horas_presenca: 0, horas_produtividade: 0 }] },
]

describe('MCP contratos de indicadores', () => {
  it('não duplica GMV ou horas da unidade no revezamento', () => {
    expect(aggregateFacts(facts)).toMatchObject({ gmv_total: 150, gmv_lives: 100, gmv_videos: 50, horas_transmissao: 4, pedidos: 3, gmv_por_hora: 25 })
  })
  it('inclui presença com venda zero e não usa dinheiro como tempo', () => {
    const rows = aggregateFacts(facts.slice(0, 1), 'apresentadora')
    expect(rows.find(x => x.id === 'a2')).toMatchObject({ gmv_total: 0, horas_presenca: 1, horas_produtividade: 0, gmv_por_hora: null, total_lives: 1 })
    expect(rows.find(x => x.id === 'a1').gmv_por_hora).toBe(25)
  })
  it('separa GMV de vídeos no acumulado e preenche dias sem atividade', () => {
    expect(evolution(facts, { inicio: '2026-10-01', fim: '2026-10-03' }, 'dia').map(x => [x.periodo, x.gmv_total, x.gmv_acumulado]))
      .toEqual([['2026-10-01', 100, 100], ['2026-10-02', 50, 150], ['2026-10-03', 0, 150]])
  })
  it('não inventa percentuais em base zero nem omite prejuízo', () => {
    expect(compareMetrics({ resultado: -20, gmv_total: 10 }, { resultado: 0, gmv_total: 5 })).toEqual({
      resultado: { atual: -20, anterior: 0, diferenca: -20, variacao_percentual: null },
      gmv_total: { atual: 10, anterior: 5, diferenca: 5, variacao_percentual: 100 },
    })
  })
  it('rejeita datas inexistentes, período invertido, consultas amplas e tenant arbitrário', () => {
    for (const args of [{ inicio: '2026-02-30', fim: '2026-03-01' }, { inicio: '2026-10-02', fim: '2026-10-01' },
      { inicio: '2024-01-01', fim: '2026-01-01' }, { inicio: '2026-10-01', fim: '2026-10-02', tenant_id: 'outro' }]) {
      expect(periodSchema.safeParse(args).success).toBe(false)
    }
  })
  it('registra as 17 ferramentas contratadas sem ação de escrita', () => {
    expect(toolDefinitions).toHaveLength(17)
    expect(new Set(toolDefinitions.map(t => t.name)).size).toBe(17)
    expect(toolDefinitions.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint)).toBe(true)
  })
  it('não transforma GMV ausente em zero ou acumulado completo', () => {
    const incomplete = [{ ...facts[0], gmv_registrado: false, gmv: 0 }, facts[1]]
    expect(aggregateFacts(incomplete)).toMatchObject({ gmv_total: null, gmv_lives: null, gmv_conhecido: 50 })
    expect(evolution(incomplete, { inicio: '2026-10-01', fim: '2026-10-02' })[1].gmv_acumulado).toBeNull()
  })
  it.each(['consultar_lives', 'consultar_cabines'])('%s carrega só lives e rejeita origem de vídeos', name => {
    const tool = toolDefinitions.find(t => t.name === name)
    expect(tool.schema.parse({ inicio: '2026-10-01', fim: '2026-10-02' }).origem).toBe('live')
    expect(tool.schema.safeParse({ inicio: '2026-10-01', fim: '2026-10-02', origem: 'video' }).success).toBe(false)
  })
})
