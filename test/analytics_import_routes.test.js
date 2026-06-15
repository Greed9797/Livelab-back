import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { analyticsRoutes } from '../src/routes/analytics.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const batchId = '33333333-3333-4333-8333-333333333333'
const rowId = '44444444-4444-4444-8444-444444444444'
const liveId = '55555555-5555-4555-8555-555555555555'

function buildApp(queryMock) {
  const app = Fastify()
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: userId, papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: userId, papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => {
    try { return await fn({ query: queryMock, release }) }
    finally { release() }
  })

  return app
}

function csvBase64() {
  const csv = [
    'MARCA,Start time,,Duration,Attributed GMV,AOV,Attributed orders,Views,LIVE impressions,Product clicks,Avg. viewing duration per viewer,Product impressions,New followers,Likes,Comments,Shares,Ads Cost,Ads GMV',
    'HAAG,46170,0.625,21600,900,100,9,3000,40000,330,27,7000,12,6000,120,8,200,1000',
  ].join('\n')
  return Buffer.from(csv).toString('base64')
}

describe('analytics imports routes', () => {
  it('previews CSV import and persists matched rows for review', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM lives l') && sql.includes('COALESCE(l.agenda_evento_id')) {
        return {
          rows: [{
            live_id: liveId,
            agenda_evento_id: null,
            marca_id: null,
            marca_nome: 'HAAG',
            iniciado_em: '2026-05-28T18:00:00.000Z',
            encerrado_em: '2026-05-29T00:00:00.000Z',
          }],
        }
      }
      if (sql.includes('INSERT INTO analytics_import_batches')) return { rows: [{ id: batchId }] }
      if (sql.includes('INSERT INTO analytics_import_rows')) return { rows: [] }
      throw new Error(`Unexpected SQL: ${sql}`)
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/imports/preview',
      payload: { filename: 'ads.csv', content_base64: csvBase64() },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      batch_id: batchId,
      summary: { total_rows: 1, matched_rows: 1 },
    })
    expect(res.json().rows[0]).toMatchObject({ match_status: 'matched', matched_live_id: liveId, ads_gmv: 1000 })
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO analytics_import_rows'))).toBe(true)

    await app.close()
  })

  it('applies matched rows to lives ads metrics and replicates official GMV to finance', async () => {
    let updateLivesArgs = null
    let insertVendaArgs = null
    const marcaId = '66666666-6666-4666-8666-666666666666'
    const normalized = {
      ads_gmv: 1000,
      ads_cost: 200,
      live_impressions: 40000,
      product_impressions: 7000,
      product_clicks: 330,
      avg_viewing_duration: 27,
      new_followers: 12,
      views: 3000,
      comments: 120,
      likes: 6000,
      shares: 8,
      attributed_orders: 9,
    }
    const queryMock = vi.fn(async (sql, args = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM analytics_import_batches') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: batchId, status: 'preview' }] }
      }
      if (sql.includes('FROM analytics_import_rows') && sql.includes("match_status = 'matched'")) {
        return { rows: [{ id: rowId, matched_live_id: liveId, normalized }] }
      }
      if (sql.includes('FROM lives l') && sql.includes('m2.id = l.marca_id')) {
        return {
          rows: [{
            id: liveId,
            cliente_id: null,
            apresentador_id: null,
            iniciado_em: '2026-05-28T18:00:00.000Z',
            contrato_id: null,
            comissao_pct: null,
            valor_fixo_comissao: '0',
            marca_id: marcaId,
            comissao_franquia_pct: '10',
            comissao_franqueadora_pct: '2',
          }],
        }
      }
      if (sql.includes('SELECT DISTINCT ap.id AS apresentadora_id')) {
        return { rows: [] }
      }
      if (sql.includes('UPDATE lives')) {
        updateLivesArgs = args
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO vendas_atribuidas')) {
        insertVendaArgs = args
        return { rows: [{ id: '77777777-7777-4777-8777-777777777777' }] }
      }
      if (sql.includes('UPDATE analytics_import_rows')) return { rows: [] }
      if (sql.includes('UPDATE analytics_import_batches')) return { rows: [] }
      throw new Error(`Unexpected SQL: ${sql}`)
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({ method: 'POST', url: `/v1/analytics/imports/${batchId}/apply` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, batch_id: batchId, applied_rows: 1 })
    expect(updateLivesArgs.slice(0, 12)).toEqual([1000, 200, 40000, 7000, 330, 27, 12, 3000, 120, 6000, 8, 9])
    const updateSql = queryMock.mock.calls.find(([sql]) => sql.includes('UPDATE lives'))?.[0]
    expect(updateSql).not.toContain('fat_gerado')
    expect(updateSql).not.toContain('comissao_calculada')
    expect(insertVendaArgs).toEqual([
      tenantId,
      liveId,
      marcaId,
      null,
      '2026-05-28',
      1000,
      0,
      0,
      100,
      20,
    ])

    await app.close()
  })
})
