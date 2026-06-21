import { describe, expect, it, vi } from 'vitest'

import { getClienteOperacional, getMarcaOperacional } from '../src/lib/operacional.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const clienteId = '22222222-2222-4222-8222-222222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'
const range = { startDate: '2026-05-01', endDate: '2026-05-31' }

function buildDb(responses, { guardMarcaId = true } = {}) {
  const calls = []
  return {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params })
      // Guard histórico: lives.marca_id não existia (pré-migration 093). Hoje existe e,
      // pós-invariante 115 + auto-cura, é confiável — o detalhe da MARCA passa a listar
      // lives por l.marca_id (inclui recentes sem comissão). O caminho do CLIENTE segue
      // sem depender de l.marca_id (lista por cliente_id), então mantém o guard.
      if (guardMarcaId && /\bl\.marca_id\b/.test(sql)) {
        throw new Error('Query must not depend on lives.marca_id (caminho cliente)')
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

  it('lista lives da marca por l.marca_id (inclui recentes, não só as com venda atribuída)', async () => {
    const db = buildDb([
      { rows: [{ id: marcaId, nome: 'Marca', cliente_nome: 'Cliente' }] },
      { rows: [{ gmv_mes: 1142, gmv_acumulado: 1142, total_lives: 1, total_videos: 0, pedidos_mes: 15 }] },
      { rows: [{ id: 'live-1', marca_id: marcaId, fat_gerado: 1142 }] },
      { rows: [] },
      { rows: [] },
    ], { guardMarcaId: false })

    const result = await getMarcaOperacional(db, { tenantId, marcaId, ...range })

    expect(result.metrics.total_lives).toBe(1)
    expect(result.lives[0].marca_id).toBe(marcaId)
    // A query de lives da marca agora filtra direto por l.marca_id (sem depender de vendas_atribuidas).
    const livesSql = db.calls[2].sql
    expect(livesSql).toContain('l.marca_id = $1')
    expect(livesSql).not.toContain('JOIN venda_live_marca')
    expect(livesSql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv')
  })
})
