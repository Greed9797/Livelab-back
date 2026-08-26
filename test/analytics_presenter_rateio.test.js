import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { analyticsRoutes } from '../src/routes/analytics.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const apresentadoraId = '33333333-3333-4333-8333-333333333333'

function buildApp(queryMock) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query: queryMock }))
  return app
}

describe('analytics presenter split', () => {
  it('uses a selected support presenter rateio in the funnel without changing tenant scope', async () => {
    const queryMock = vi.fn(async (sql, params = []) => {
      expect(sql).toContain('current_setting(\'app.tenant_id\', true)::uuid')
      expect(sql).toContain('($4::uuid IS NULL OR lav.apresentadora_id = $4::uuid)')
      expect(sql).toContain('ap_v2.gmv_rateado')
      expect(sql).toContain('ap_v2.segundos_rateio')
      expect(sql).toContain('live_sales.pedidos')
      expect(params).toEqual(['2026-08-17', '2026-08-17', null, apresentadoraId])
      return { rows: [{}] }
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)
    const response = await app.inject({
      method: 'GET',
      url: `/v1/analytics/funil?from=2026-08-17&to=2026-08-17&apresentadora_id=${apresentadoraId}`,
    })

    expect(response.statusCode).toBe(200)
    await app.close()
  })
})
