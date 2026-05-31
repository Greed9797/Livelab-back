import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { analyticsRoutes } from '../src/routes/analytics.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const apresentadoraId = '33333333-3333-4333-8333-333333333333'

function buildApp(queryMock) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query: queryMock }))
  return app
}

describe('analytics diario', () => {
  it('returns daily rows and applies marca/apresentadora filters', async () => {
    const queryMock = vi.fn(async (sql, params = []) => {
      expect(sql).toContain('generate_series($1::date, $2::date')
      expect(sql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)')
      expect(sql).toContain('($3::uuid IS NULL OR l.marca_id = $3::uuid)')
      expect(sql).toContain('($4::uuid IS NULL OR COALESCE(ap_v2.apresentadora_id, ap_user.id) = $4::uuid)')
      expect(sql).toContain("va.origem = 'video'")
      expect(params).toEqual(['2026-05-01', '2026-05-31', marcaId, apresentadoraId])
      return {
        rows: [{
          dia: '2026-05-28',
          total_lives: 2,
          total_videos: 1,
          gmv_lives: '1000.50',
          gmv_videos: '200.25',
          horas_live: '5.5',
          pedidos: 12,
        }],
      }
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/analytics/diario?mesAno=2026-05&marca_id=${marcaId}&apresentadora_id=${apresentadoraId}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      periodo: { from: '2026-05-01', to: '2026-05-31', mesAno: '2026-05' },
      filters: { marca_id: marcaId, apresentadora_id: apresentadoraId },
      rows: [{
        dia: '2026-05-28',
        gmv_total: 1200.75,
        gmv_lives: 1000.5,
        gmv_videos: 200.25,
        total_lives: 2,
        total_videos: 1,
        horas_live: 5.5,
        gmv_por_live: 600.38,
        gmv_por_hora: 218.32,
        pedidos: 12,
        ticket_medio: 100.06,
      }],
    })
    await app.close()
  })

  it('rejects invalid UUID filters', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics/diario?mesAno=2026-05&marca_id=invalido',
    })

    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })
})
