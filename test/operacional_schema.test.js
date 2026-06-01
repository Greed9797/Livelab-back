import { describe, expect, it, vi } from 'vitest'

import { getClienteOperacional, getMarcaOperacional } from '../src/lib/operacional.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const clienteId = '22222222-2222-4222-8222-222222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'
const range = { startDate: '2026-05-01', endDate: '2026-05-31' }

function buildDb(responses) {
  const calls = []
  return {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params })
      if (/\bl\.marca_id\b/.test(sql)) {
        throw new Error('Query must not depend on lives.marca_id; production schema does not have this column')
      }
      return responses.shift() ?? { rows: [] }
    }),
  }
}

describe('operacional helpers', () => {
  it('builds cliente detail without querying lives.marca_id', async () => {
    const db = buildDb([
      { rows: [{ id: clienteId, nome: 'Cliente' }] },
      { rows: [{ id: marcaId, nome: 'Marca', cliente_id: clienteId }] },
      { rows: [{ gmv_mes: 1142, gmv_acumulado: 1142, total_lives: 1, total_videos: 0, pedidos_mes: 15 }] },
      { rows: [{ id: 'live-1', marca_id: marcaId, fat_gerado: 1142 }] },
      { rows: [] },
      { rows: [] },
    ])

    const result = await getClienteOperacional(db, { tenantId, clienteId, ...range })

    expect(result.metrics.gmv_mes).toBe(1142)
    expect(result.lives).toHaveLength(1)
    expect(db.calls.some(({ sql }) => /\bl\.marca_id\b/.test(sql))).toBe(false)
    expect(db.calls[2].sql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv')
    expect(db.calls[2].sql).toContain('COALESCE(l.manual_orders, l.final_orders_count, 0) AS pedidos')
    expect(db.calls[2].sql).toContain('SUM(ll.gmv)')
    expect(db.calls[2].sql).toContain('SUM(ll.pedidos)')
    expect(db.calls[3].sql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv')
    expect(db.calls[3].sql).toContain('COALESCE(l.manual_orders, l.final_orders_count, 0) AS pedidos')
  })

  it('builds marca detail from vendas_atribuidas instead of lives.marca_id', async () => {
    const db = buildDb([
      { rows: [{ id: marcaId, nome: 'Marca', cliente_nome: 'Cliente' }] },
      { rows: [{ gmv_mes: 1142, gmv_acumulado: 1142, total_lives: 1, total_videos: 0, pedidos_mes: 15 }] },
      { rows: [{ id: 'live-1', marca_id: marcaId, fat_gerado: 1142 }] },
      { rows: [] },
      { rows: [] },
    ])

    const result = await getMarcaOperacional(db, { tenantId, marcaId, ...range })

    expect(result.metrics.total_lives).toBe(1)
    expect(result.lives[0].marca_id).toBe(marcaId)
    expect(db.calls.some(({ sql }) => /\bl\.marca_id\b/.test(sql))).toBe(false)
    expect(db.calls[2].sql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv')
    expect(db.calls[2].sql).toContain('COALESCE(l.manual_orders, l.final_orders_count, 0) AS pedidos')
  })
})
