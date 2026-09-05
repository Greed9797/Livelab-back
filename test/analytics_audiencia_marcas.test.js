import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { analyticsRoutes } from '../src/routes/analytics.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'

function buildApp(queryMock, { authenticated = true, role = 'franqueado' } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request, reply) => {
    if (!authenticated) return reply.code(401).send({ error: 'Unauthorized' })
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: role }
  })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user?.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (scopeTenantId, fn) => {
    expect(scopeTenantId).toBe(tenantId)
    return fn({ query: queryMock })
  })
  return app
}

describe('GET /v1/analytics/audiencia-marcas', () => {
  it('agrega campos brutos por marca e preserva nulo versus zero registrado', async () => {
    const queryMock = vi.fn(async (sql, params = []) => {
      expect(sql).toContain("current_setting('app.tenant_id', true)::uuid")
      expect(sql).toContain("AT TIME ZONE 'America/Sao_Paulo'")
      expect(sql).toContain('>= 300')
      expect(sql).toContain('SUM(l.manual_views) FILTER')
      expect(sql).not.toContain('final_peak_viewers')
      expect(sql).not.toContain('live_apresentadoras_v2')
      expect(sql).not.toContain('ads_gmv')
      expect(params).toEqual(['2026-09-01', '2026-09-05', marcaId])
      return {
        rows: [
          {
            marca_id: marcaId,
            marca_nome: 'Marca com zero',
            lives_total: '2',
            lives_com_import: '2',
            impressoes_live: '0',
            lives_com_impressoes_registradas: '2',
            visualizacoes_manuais: '0',
            lives_com_visualizacoes_registradas: '2',
            impressoes_produto: null,
            lives_com_impressoes_produto_registradas: '0',
            cliques_produto: null,
            lives_com_cliques_produto_registrados: '0',
          },
        ],
      }
    })
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const response = await app.inject({
      method: 'GET',
      url: `/v1/analytics/audiencia-marcas?from=2026-09-01&to=2026-09-05&marca_id=${marcaId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      periodo: { from: '2026-09-01', to: '2026-09-05', mesAno: '2026-09' },
      filtros: { marca_id: marcaId },
      rows: [{
        marca_id: marcaId,
        marca_nome: 'Marca com zero',
        lives_total: 2,
        impressoes_live: 0,
        lives_com_impressoes_registradas: 2,
        impressoes_produto: null,
        lives_com_impressoes_produto_registradas: 0,
      }],
    })
    await app.close()
  })

  it('rejeita autenticação, UUID inválido e filtro de apresentadora que mudaria a semântica', async () => {
    const unauthenticatedQuery = vi.fn()
    const unauthenticated = buildApp(unauthenticatedQuery, { authenticated: false })
    await unauthenticated.register(analyticsRoutes)
    expect((await unauthenticated.inject({ method: 'GET', url: '/v1/analytics/audiencia-marcas?mesAno=2026-09' })).statusCode).toBe(401)
    expect(unauthenticatedQuery).not.toHaveBeenCalled()
    await unauthenticated.close()

    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)
    expect((await app.inject({ method: 'GET', url: '/v1/analytics/audiencia-marcas?mesAno=2026-09&marca_id=invalida' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/analytics/audiencia-marcas?mesAno=2026-09&apresentadora_id=33333333-3333-4333-8333-333333333333' })).statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('nega papel sem acesso ao Analytics antes de consultar dados', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock, { role: 'sem_permissao' })
    await app.register(analyticsRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/analytics/audiencia-marcas?mesAno=2026-09' })
    expect(response.statusCode).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('não expõe detalhes internos quando a consulta falha', async () => {
    const queryMock = vi.fn().mockRejectedValue(new Error('SQL private details: internal_table'))
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/analytics/audiencia-marcas?mesAno=2026-09' })
    expect(response.statusCode).toBe(500)
    expect(response.json().error).toBeTruthy()
    expect(response.body).not.toContain('private')
    expect(response.body).not.toContain('internal_table')
    await app.close()
  })
})
