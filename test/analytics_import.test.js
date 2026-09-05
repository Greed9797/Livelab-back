import { describe, expect, it } from 'vitest'

import {
  matchAnalyticsImportRows,
  normalizeBrandName,
  parseAnalyticsImportBuffer,
  parseDurationToSeconds,
  recoverImportMetrics,
} from '../src/services/analytics-import.js'

describe('analytics import parser and matcher', () => {
  it('normalizes TikTok Ads CSV rows using Ads GMV as official live GMV', () => {
    const csv = [
      'MARCA,Start time,,Duration,Attributed GMV,AOV,Attributed orders,Views,LIVE impressions,Impressions per hour,GMV Per Hour,Avg. viewing duration,Tap-through rate,CTR,CTOR,LIVE CTR,SKU order rate,Product clicks,CTOR (SKU order),Avg. viewing duration per viewer,Product impressions,Watch GPM,New followers,Follow rate,Comment rate,Share rate,Like rate,Likes,Comments,Shares,Ads ROAS,Ads Cost,Ads GMV',
      'HAAG,46170,0.625,21600,900,100,9,3000,40000,,,,,,,,,330,,27,7000,,12,,,,,6000,120,8,5,200,1000',
    ].join('\n')

    const { source_type, rows } = parseAnalyticsImportBuffer({ filename: 'ads.csv', buffer: Buffer.from(csv) })

    expect(source_type).toBe('tiktok_ads')

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
    const { rows: [row] } = parseAnalyticsImportBuffer({
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
    const { rows: [row] } = parseAnalyticsImportBuffer({
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
    const { rows: [row] } = parseAnalyticsImportBuffer({
      filename: 'ads.csv',
      buffer: Buffer.from([
        'MARCA,Start time,,Duration,Ads Cost,Ads GMV',
        'ROVITEX,46160,0.315,454,0,',
      ].join('\n')),
    })

    expect(row.errors).toEqual([])
    expect(row.normalized.duration_seconds).toBe(454)
    expect(row.normalized.ads_gmv).toBeNull()
    expect(row.normalized.metric_presence.ads_gmv).toBe('missing')
  })

  it('distinguishes an omitted metric from explicit zero', () => {
    const parse = (orders) => parseAnalyticsImportBuffer({
      filename: 'ads.csv',
      buffer: Buffer.from([
        'MARCA,Start time,,Duration,Attributed orders,Views,Ads GMV',
        `HAAG,46170,0.625,21600,${orders},,`,
      ].join('\n')),
    }).rows[0].normalized
    expect(parse('   ').attributed_orders).toBeNull()
    expect(parse('   ').metric_presence.attributed_orders).toBe('missing')
    expect(parse('0').attributed_orders).toBe(0)
    expect(parse('0').metric_presence.attributed_orders).toBe('zero')
  })

  it('recovers presence from raw for legacy rows without trusting normalized zero', () => {
    const recovered = recoverImportMetrics(
      { views: 0, attributed_orders: 0, ads_gmv: 0 },
      { Views: '', 'Attributed orders': '0', 'Ads GMV': 'R$' },
      'tiktok_ads',
    )
    expect(recovered.views).toBeNull()
    expect(recovered.attributed_orders).toBe(0)
    expect(recovered.ads_gmv).toBeNull()
    expect(recovered.metric_presence).toMatchObject({ views: 'missing', attributed_orders: 'zero', ads_gmv: 'unknown', official_gmv: 'unknown' })
  })
})

describe('uma live não pode receber duas linhas do mesmo arquivo', () => {
  // Duas lives distintas do TikTok sobrepondo a mesma janela. Sem atribuição exclusiva, as duas
  // casavam com a mesma live e o apply gravava uma por cima da outra — o GMV de uma sumia.
  const duasLinhas = [
    'Room ID,Room Title,Start Time,End Time,Duration,Attributed GMV,Attributed orders,Views,Likes',
    '111,Live A,2026-07-23 08:00:00,2026-07-23 11:00:00,3h,"R$ 100.00",1,10,5',
    '222,Live B,2026-07-23 08:30:00,2026-07-23 11:30:00,3h,"R$ 200.00",2,20,6',
  ].join('\n')

  const candidato = (liveId, inicio, fim) => ({
    live_id: liveId,
    agenda_evento_id: null,
    marca_id: 'M1',
    marca_nome: 'X',
    marca_key: 'x',
    iniciado_em: inicio,
    encerrado_em: fim,
    start_ms: new Date(inicio).getTime(),
    end_ms: new Date(fim).getTime(),
  })

  const parse = () => parseAnalyticsImportBuffer({ filename: 'x.csv', buffer: Buffer.from(duasLinhas) }).rows

  it('gives the live to the best-scoring row and leaves the other unmatched', () => {
    const matched = matchAnalyticsImportRows(
      parse(),
      [candidato('LIVE-UNICA', '2026-07-23T11:00:00Z', '2026-07-23T14:00:00Z')],
      { marcaId: 'M1' },
    )
    const vinculadas = matched.filter((r) => r.matched_live_id).map((r) => r.matched_live_id)
    expect(new Set(vinculadas).size).toBe(vinculadas.length)
    expect(vinculadas).toHaveLength(1)
    expect(matched.find((r) => !r.matched_live_id)?.match_reason).toContain('ja foi vinculada')
  })

  it('still matches every row when there are enough distinct lives', () => {
    const matched = matchAnalyticsImportRows(
      parse(),
      [
        candidato('LIVE-A', '2026-07-23T11:00:00Z', '2026-07-23T14:00:00Z'),
        candidato('LIVE-B', '2026-07-23T11:30:00Z', '2026-07-23T14:30:00Z'),
      ],
      { marcaId: 'M1' },
    )
    const vinculadas = matched.filter((r) => r.matched_live_id).map((r) => r.matched_live_id)
    expect(vinculadas).toHaveLength(2)
    expect(new Set(vinculadas).size).toBe(2)
  })
})

describe('rateio das apresentadoras na escala do banco', () => {
  // percentual_rateio é NUMERIC(5,2). Uma tolerância de 0.01 aceitaria 33.335 × 3, que o banco
  // arredonda para 33.34 cada e passa a somar 100.02 — GMV rateado além do total da live.
  const somaCentesimos = (percentuais) => percentuais.reduce((acc, p) => acc + Math.round(p * 100), 0)

  it('rejects splits that only reach 100% before rounding', () => {
    expect(somaCentesimos([33.335, 33.335, 33.335])).not.toBe(10000)
    expect(somaCentesimos([33.33, 33.33, 33.33])).not.toBe(10000)
  })

  it('accepts splits that are exact at two decimals', () => {
    expect(somaCentesimos([60, 40])).toBe(10000)
    expect(somaCentesimos([33.33, 33.33, 33.34])).toBe(10000)
    expect(somaCentesimos([50, 25, 25])).toBe(10000)
  })
})

describe('TikTok Studio "Creator Live Performance"', () => {
  // Formato real do export: linha 1 = data, linha 2 vazia, linha 3 = cabeçalho, tudo como texto.
  const studioCsv = [
    '2026-07-23',
    '',
    'Room ID,Room Title,Start Time,End Time,Duration,Attributed GMV,Attributed items sold,Attributed orders,Attributed SKU orders,Customers,AOV,Views,Impressions,GMV per hour,Avg. viewing duration per view,Product Impressions,Product clicks,New followers,Comments,Comment rate,Shares,Likes,Like rate',
    '7665678832292088583,Moda Plus Size Oferta Posthaus,2026-07-23 08:09:17,2026-07-23 10:46:54,2h37m,"R$ 413.57",3,3,3,3,"R$ 137.86",845,17061,"R$ 157.43",31.98,4364,238,7,26,3.076923%,2,1661,201.57767%',
  ].join('\n')

  const parse = () => parseAnalyticsImportBuffer({
    filename: 'Creator-Live-Performance.csv',
    buffer: Buffer.from(studioCsv),
  })

  it('detects the Studio format even with the header on the third line', () => {
    const { source_type, rows } = parse()
    expect(source_type).toBe('tiktok_studio')
    expect(rows).toHaveLength(1)
    expect(rows[0].errors).toEqual([])
  })

  it('reads GMV stored as text and keeps the 19-digit Room ID as a string', () => {
    const { rows: [row] } = parse()
    expect(row.normalized.attributed_gmv).toBe(413.57)
    // 7665678832292088583 > Number.MAX_SAFE_INTEGER: virar número perderia precisão.
    expect(row.normalized.room_id).toBe('7665678832292088583')
    expect(typeof row.normalized.room_id).toBe('string')
  })

  it('anchors the local timestamp to -03:00 so the live does not shift 3 hours in UTC', () => {
    const { rows: [row] } = parse()
    expect(row.normalized.started_at).toBe('2026-07-23T08:09:17-03:00')
    expect(new Date(row.normalized.started_at).toISOString()).toBe('2026-07-23T11:09:17.000Z')
  })

  it('derives the duration from the real interval instead of the rounded "2h37m"', () => {
    const { rows: [row] } = parse()
    expect(parseDurationToSeconds('2h37m')).toBe(9420)
    expect(row.normalized.duration_seconds).toBe(9457)
  })

  it('preserves rates that cannot be derived from the absolute numbers', () => {
    const { rows: [row] } = parse()
    // Like rate usa espectadores únicos (824), Comment rate usa Views (845): não dá para recalcular.
    expect(row.normalized.studio_metrics.like_rate).toBe(201.57767)
    expect(row.normalized.studio_metrics.comment_rate).toBe(3.076923)
    expect(row.normalized.studio_metrics.customers).toBe(3)
    expect(row.normalized.studio_metrics.room_title).toBe('Moda Plus Size Oferta Posthaus')
  })

  it('restricts candidates to the brand chosen in the UI, since the sheet has no brand column', () => {
    const { rows } = parse()
    const candidato = (marcaId, liveId) => ({
      live_id: liveId,
      agenda_evento_id: null,
      marca_id: marcaId,
      marca_nome: 'Posthaus',
      marca_key: normalizeBrandName('Posthaus'),
      iniciado_em: '2026-07-23T11:09:00.000Z',
      encerrado_em: '2026-07-23T13:46:00.000Z',
      start_ms: new Date('2026-07-23T11:09:00.000Z').getTime(),
      end_ms: new Date('2026-07-23T13:46:00.000Z').getTime(),
    })

    const marcaCerta = matchAnalyticsImportRows(rows, [candidato('marca-1', 'live-1')], { marcaId: 'marca-1' })
    expect(marcaCerta[0].match_status).toBe('matched')
    expect(marcaCerta[0].matched_live_id).toBe('live-1')

    const marcaErrada = matchAnalyticsImportRows(rows, [candidato('marca-2', 'live-2')], { marcaId: 'marca-1' })
    expect(marcaErrada[0].match_status).toBe('unmatched')
  })
})
