import { describe, expect, it, vi } from 'vitest'

import { getPerformanceRanking } from '../src/lib/performance-rollups.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const apresentadoraId = '33333333-3333-4333-8333-333333333333'
const range = { mes: '2026-05', start: '2026-05-01', end: '2026-06-01' }

describe('performance rollups', () => {
  it('builds presenter ranking from the same live+video source used by analytics', async () => {
    const query = vi.fn(async (sql, params) => {
      expect(sql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv')
      expect(sql).toContain("va.origem = 'video'")
      expect(sql).toContain('COALESCE(ap_v2.apresentadora_id, ap_user.id)')
      expect(sql).toContain('va.apresentadora_id = $7::uuid')
      expect(params).toEqual([tenantId, range.start, range.end, 10, null, marcaId, apresentadoraId, null])
      return {
        rows: [{
          apresentadora_id: apresentadoraId,
          apresentadora_nome: 'Ana',
          apresentadora_foto_url: null,
          gmv_total: '1200.50',
          gmv_lives: '1000.00',
          gmv_videos: '200.50',
          pedidos: 12,
          total_lives: 2,
          total_videos: 1,
          comissao_apresentadora: '60.25',
          fixo: '100.00',
          total_recebido: '160.25',
        }],
      }
    })

    const rows = await getPerformanceRanking({
      query,
    }, {
      tenantId,
      range,
      groupBy: 'apresentadora',
      limit: 10,
      marcaId,
      apresentadoraId,
    })

    expect(rows[0]).toMatchObject({
      id: apresentadoraId,
      apresentadora_id: apresentadoraId,
      nome: 'Ana',
      gmv_total: 1200.5,
      gmv: 1200.5,
      gmv_lives: 1000,
      gmv_videos: 200.5,
      pedidos: 12,
      total_lives: 2,
      lives: 2,
      comissao_apresentadora: 60.25,
      total_recebido: 160.25,
      mes: '2026-05',
    })
  })

  it('builds brand ranking with the same canonical fields', async () => {
    const query = vi.fn(async (sql, params) => {
      expect(sql).toContain('l.marca_id')
      expect(sql).toContain("va.origem = 'video'")
      expect(sql).toContain('va.marca_id = $6::uuid')
      expect(params).toEqual([tenantId, range.start, range.end, 5, null, marcaId, null, 'live'])
      return {
        rows: [{
          marca_id: marcaId,
          marca_nome: 'Haag',
          logo_url: null,
          site: null,
          gmv_total: '900.00',
          gmv_lives: '900.00',
          gmv_videos: '0',
          pedidos: 9,
          total_lives: 3,
          total_videos: 0,
          comissao_apresentadora: '45.00',
          comissao_franquia: '90.00',
          comissao_franqueadora: '20.00',
        }],
      }
    })

    const rows = await getPerformanceRanking({
      query,
    }, {
      tenantId,
      range,
      groupBy: 'marca',
      limit: 5,
      marcaId,
      origem: 'live',
    })

    expect(rows[0]).toMatchObject({
      id: marcaId,
      marca_id: marcaId,
      nome: 'Haag',
      marca_nome: 'Haag',
      gmv_total: 900,
      gmv: 900,
      pedidos_total: 9,
      total_lives: 3,
      comissao_apresentadora: 45,
      comissao_franquia: 90,
      comissao_franqueadora: 20,
    })
  })
})
