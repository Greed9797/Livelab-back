import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { financeiroRoutes } from '../src/routes/financeiro.js'

const tenantId = '11111111-1111-4111-8111-111111111111'

function buildApp(query) {
  const app = Fastify()
  app.decorate('requirePapel', () => async (request) => {
    request.user = { tenant_id: tenantId, papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query }))
  return app
}

describe('GET /v1/financeiro/faturamento — identidade de cliente', () => {
  it('expõe a rota da entidade e resolve live legada pela marca somente sem cliente explícito', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: '22222222-2222-4222-8222-222222222222',
      nome: 'Mesmo Nome',
      tipo_entidade: 'cliente',
      cliente_id: '22222222-2222-4222-8222-222222222222',
      marca_id: null,
      total: '100', receita_liquida: '10', lives_mes: '1', videos_mes: '0',
    }] })
    const app = buildApp(query)
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/faturamento?inicio=2026-06&fim=2026-06' })

    expect(res.statusCode).toBe(200)
    expect(res.json().por_cliente[0]).toMatchObject({
      tipo_entidade: 'cliente',
      cliente_id: '22222222-2222-4222-8222-222222222222',
      marca_id: null,
      gmv_mes: 100,
      receita_liquida: 10,
    })

    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('COALESCE(l.cliente_id, marca_cliente.cliente_id) AS cliente_id')
    expect(sql).toContain('LEFT JOIN marcas marca_cliente ON marca_cliente.id = l.marca_id')
    expect(sql).toContain('CASE WHEN cliente_id IS NULL THEN marca_id END')
    expect(sql).toContain("END AS tipo_entidade")
    expect(sql).toContain('cl.id AS cliente_id')
    expect(sql).toContain('m.id AS marca_id')
    await app.close()
  })
})
