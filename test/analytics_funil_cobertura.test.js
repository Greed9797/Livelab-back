import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { analyticsRoutes } from '../src/routes/analytics.js'

function buildApp(queryMock) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: '11111111-1111-4111-8111-111111111111', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query: queryMock }))
  return app
}

describe('GET /v1/analytics/funil coverage', () => {
  it('keeps registered zero separate from a field missing in every live', async () => {
    const queryMock = vi.fn(async (sql) => {
      expect(sql).toContain('COUNT(*) FILTER (WHERE l.live_impressions IS NOT NULL)')
      expect(sql).toContain('COUNT(*) FILTER (WHERE l.product_impressions IS NOT NULL)')
      expect(sql).toContain('COUNT(*) FILTER (WHERE l.product_clicks IS NOT NULL)')
      return {
        rows: [{
          total_lives: '2', impressoes: '0', lives_com_impressoes_registradas: '2',
          visualizacoes: '0', impressoes_produto: '0', lives_com_impressoes_produto_registradas: '2',
          cliques: '0', lives_com_cliques_produto_registrados: '0', pedidos: '0',
          gmv: '0', horas_live: '0', likes: '0', novos_seguidores: '0', like_rate_medio: null,
        }],
      }
    })
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/analytics/funil?from=2026-09-01&to=2026-09-05' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      tem_dados_ads: false,
      cobertura: {
        lives_com_impressoes_registradas: 2,
        lives_com_impressoes_produto_registradas: 2,
        lives_com_cliques_produto_registrados: 0,
      },
    })
    await app.close()
  })
})
