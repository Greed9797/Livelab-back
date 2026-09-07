import { describe, it, expect } from 'vitest'
import { getOwnPortalPerformance } from '../src/services/portal-apresentadora-performance.js'

const args = { tenantId: 'tenant', apresentadoraId: 'presenter', range: { start: '2026-09-01', end: '2026-10-01' } }
describe('portal own performance DTO', () => {
  it('counts zero-GMV lives, preserves precision and strips financial/private columns', async () => {
    const result = await getOwnPortalPerformance({ query: async () => ({ rows: [
      { id: 'zero', gmv: '0', horas: '2', pedidos: '0', fixo: 2700, comissao: 99, cpf: 'private' },
      { id: 'split', gmv: '500.25', horas: '1.5', pedidos: '3', nome_colega: 'private' },
    ] }) }, args)
    expect(result.desempenho).toEqual({ total_lives: 2, gmv_lives: 500.25, horas_live: 3.5, gmv_por_hora: 142.93, pedidos: 3 })
    expect(result.items.every(item => !('fixo' in item) && !('comissao' in item) && !('cpf' in item) && !('nome_colega' in item))).toBe(true)
  })
  it('does not manufacture a rate without attributed hours', async () => {
    const result = await getOwnPortalPerformance({ query: async () => ({ rows: [] }) }, args)
    expect(result.desempenho).toEqual({ total_lives: 0, gmv_lives: 0, horas_live: 0, gmv_por_hora: null, pedidos: 0 })
  })
})
