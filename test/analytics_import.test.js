import { describe, expect, it } from 'vitest'

import {
  matchAnalyticsImportRows,
  normalizeBrandName,
  parseAnalyticsImportBuffer,
} from '../src/services/analytics-import.js'

describe('analytics import parser and matcher', () => {
  it('normalizes TikTok Ads CSV rows using Ads GMV as official live GMV', () => {
    const csv = [
      'MARCA,Start time,,Duration,Attributed GMV,AOV,Attributed orders,Views,LIVE impressions,Impressions per hour,GMV Per Hour,Avg. viewing duration,Tap-through rate,CTR,CTOR,LIVE CTR,SKU order rate,Product clicks,CTOR (SKU order),Avg. viewing duration per viewer,Product impressions,Watch GPM,New followers,Follow rate,Comment rate,Share rate,Like rate,Likes,Comments,Shares,Ads ROAS,Ads Cost,Ads GMV',
      'HAAG,46170,0.625,21600,900,100,9,3000,40000,,,,,,,,,330,,27,7000,,12,,,,,6000,120,8,5,200,1000',
    ].join('\n')

    const rows = parseAnalyticsImportBuffer({ filename: 'ads.csv', buffer: Buffer.from(csv) })

    expect(rows).toHaveLength(1)
    expect(rows[0].normalized).toMatchObject({
      marca_nome: 'HAAG',
      live_date: '2026-05-28',
      start_time: '15:00',
      duration_seconds: 21600,
      ads_gmv: 1000,
      ads_cost: 200,
      attributed_orders: 9,
      views: 3000,
      comments: 120,
    })
  })

  it('matches rows by brand and interval overlap, not by exact start time only', () => {
    const [row] = parseAnalyticsImportBuffer({
      filename: 'ads.csv',
      buffer: Buffer.from([
        'MARCA,Start time,,Duration,Attributed GMV,AOV,Attributed orders,Views,LIVE impressions,Product clicks,Avg. viewing duration per viewer,Product impressions,New followers,Likes,Comments,Shares,Ads Cost,Ads GMV',
        'HÁAG,46170,0.625,21600,900,100,9,3000,40000,330,27,7000,12,6000,120,8,200,1000',
      ].join('\n')),
    })

    const matched = matchAnalyticsImportRows([row], [{
      live_id: 'live-1',
      agenda_evento_id: 'agenda-1',
      marca_nome: 'HAAG',
      marca_key: normalizeBrandName('HAAG'),
      iniciado_em: '2026-05-28T18:30:00.000Z',
      encerrado_em: '2026-05-29T00:00:00.000Z',
      start_ms: new Date('2026-05-28T18:30:00.000Z').getTime(),
      end_ms: new Date('2026-05-29T00:00:00.000Z').getTime(),
    }])

    expect(matched[0].match_status).toBe('matched')
    expect(matched[0].matched_live_id).toBe('live-1')
    expect(matched[0].match_confidence).toBeGreaterThan(0.9)
  })

  it('does not auto-apply short test lives under 5 minutes', () => {
    const [row] = parseAnalyticsImportBuffer({
      filename: 'ads.csv',
      buffer: Buffer.from([
        'MARCA,Start time,,Duration,Ads Cost,Ads GMV',
        'HAAG,46170,0.625,120,20,50',
      ].join('\n')),
    })

    const matched = matchAnalyticsImportRows([row], [])

    expect(matched[0].match_status).toBe('skipped_short')
  })

  it('keeps long rows without Ads GMV so live counts stay faithful to the export', () => {
    const [row] = parseAnalyticsImportBuffer({
      filename: 'ads.csv',
      buffer: Buffer.from([
        'MARCA,Start time,,Duration,Ads Cost,Ads GMV',
        'ROVITEX,46160,0.315,454,0,',
      ].join('\n')),
    })

    expect(row.errors).toEqual([])
    expect(row.normalized.duration_seconds).toBe(454)
    expect(row.normalized.ads_gmv).toBeNull()
  })
})
