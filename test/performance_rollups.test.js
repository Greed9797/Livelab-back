import { describe, expect, it, vi } from 'vitest'

import { apresentadoraHorasSql } from '../src/lib/metric-sql.js'
import { getPerformanceRanking } from '../src/lib/performance-rollups.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const apresentadoraId = '33333333-3333-4333-8333-333333333333'
const range = { mes: '2026-05', start: '2026-05-01', end: '2026-06-01' }

describe('performance rollups', () => {
  it('builds presenter ranking from the same live+video source used by analytics', async () => {
    const query = vi.fn(async (sql, params) => {
      expect(sql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)')
      expect(sql).toContain('END AS gmv')
      expect(sql).toContain("va.origem = 'video'")
      expect(sql).toContain('ap_v2.gmv_rateado')
      expect(sql).toContain('ap_v2.segundos_rateio')
      expect(sql).toContain("ap_v2.papel = 'principal'")
      expect(sql).toContain('lav.apresentadora_id = $7::uuid')
      expect(sql).not.toMatch(/FROM live_apresentadoras_v2 lav[\s\S]*?LIMIT 1[\s\S]*?live_commission/)
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

describe('apresentadoraHorasSql', () => {
  it('é a mesma expressão que o ranking por apresentadora emite, sem cópia divergente', async () => {
    // A expressão vivia inline aqui e estava copiada em mais três lugares do repo, já
    // divergindo entre si. Este teste é a trava: se alguém editar uma das pontas, o ranking
    // e o indicador de assiduidade passam a reportar horas diferentes na mesma tela.
    let capturado = ''
    const query = vi.fn(async (sql) => {
      capturado = sql
      return { rows: [] }
    })

    await getPerformanceRanking({ query }, { tenantId, range, groupBy: 'apresentadora' })

    expect(capturado).toContain(`${apresentadoraHorasSql()} AS horas`)
  })

  it('mantém os três degraus da cascata na ordem, com o teto de 24h nos dois de duração', () => {
    // O rateio PLANEJADO grava percentual_rateio e deixa segundos_rateio NULL de propósito,
    // para as horas se autocorrigirem quando a live encerra. Trocar a ordem dos degraus faz o
    // percentual ser ignorado (ou o planejado congelar num palpite) sem quebrar nada visível.
    const sql = apresentadoraHorasSql()
    const degraus = [
      sql.indexOf('ap_v2.segundos_rateio / 3600.0'),
      sql.indexOf('* ap_v2.percentual_rateio / 100.0'),
      sql.indexOf("CASE WHEN ap_v2.papel = 'principal'"),
    ]
    expect(degraus.every((i) => i >= 0)).toBe(true)
    expect(degraus).toEqual([...degraus].sort((a, b) => a - b))

    // Teto de 24h: sem ele uma live esquecida aberta inventa centenas de horas de presença.
    // Aparece 3x — nos dois degraus de duração e no fallback sem linha de rateio.
    expect(sql.match(/, 24\.0\)/g)).toHaveLength(3)
    // E o 1º degrau NÃO é capado de propósito: segundos_rateio já é tempo medido.
    expect(sql).not.toContain('LEAST(ap_v2.segundos_rateio')
  })

  it('aceita alias diferente de live e de rateio, para o endpoint de assiduidade', () => {
    const sql = apresentadoraHorasSql({ live: 'lv', rateio: 'rat' })
    expect(sql).toContain('rat.segundos_rateio / 3600.0')
    expect(sql).toContain('lv.encerrado_em')
    expect(sql).not.toContain('ap_v2.')
    expect(sql).not.toMatch(/\bl\./)
  })
})
