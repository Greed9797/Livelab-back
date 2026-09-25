import { describe, it, expect, vi } from 'vitest'
vi.mock('../src/lib/performance-rollups.js', () => ({ getPerformanceRanking: vi.fn() }))
vi.mock('../src/lib/presenter-pending.js', () => ({ pendingRows: vi.fn() }))
import { getPerformanceRanking } from '../src/lib/performance-rollups.js'
import { pendingRows } from '../src/lib/presenter-pending.js'
import { getOperationalRanking } from '../src/lib/operational-ranking.js'

describe('operational ranking projection', () => {
  it('adds safe declarations, exposes collisions and preserves all official financial values', async () => {
    const original = { id: 'a', marca_id: 'a', gmv_total: 100, gmv_lives: 100, gmv: 100, horas_live: 1, pedidos: 2, total_lives: 1, comissao_variavel: 8, comissao_apresentadora: 8, comissao_franquia: 4, fixo: 200, total_recebido: 208 }
    getPerformanceRanking.mockResolvedValue([original])
    pendingRows.mockResolvedValue([
      { marca_id: 'a', pendente_aprovacao: true, gmv_declarado: '19.99', pedidos_declarados: 1, iniciado_em: '2026-09-11T12:00Z', encerrado_em: '2026-09-11T13:00Z' },
      { marca_id: 'a', pendente_aprovacao: true, em_conciliacao: true, gmv_declarado: '100' },
    ])
    const [row] = await getOperationalRanking({}, { tenantId: 'tenant', clienteId: 'client', range: { start: '2026-09-01', end: '2026-10-01' }, groupBy: 'marca', limit: 10 })
    expect(row.gmv_total).toBe(100)
    expect(row.total_lives).toBe(1)
    expect(row.pedidos).toBe(2)
    expect(row.gmv_pendente_aprovacao).toBe(119.99)
    expect(row.total_lives_pendentes_aprovacao).toBe(2)
    expect(row.total_provisorio).toBeNull()
    for (const key of ['comissao_variavel','comissao_apresentadora','comissao_franquia','fixo','total_recebido']) expect(row[key]).toBe(original[key])
    expect(original.gmv_total).toBe(100)
    expect(pendingRows).toHaveBeenCalledWith({}, expect.objectContaining({ tenantId: 'tenant', clienteId: 'client' }))
  })
  it('never projects live declarations into video-only rankings', async () => {
    pendingRows.mockClear()
    getPerformanceRanking.mockResolvedValue([{ id: 'v', gmv_total: 50 }])
    expect(await getOperationalRanking({}, { origem: 'video' })).toEqual([{ id: 'v', gmv_total: 50 }])
    expect(pendingRows).not.toHaveBeenCalled()
  })
})
