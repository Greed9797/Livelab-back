import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { marcasRoutes } from '../src/routes/marcas.js'

const tenantId = '00000000-0000-4000-8000-000000000001'
const marcaId = '00000000-0000-4000-8000-000000000002'

function buildApp(query) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: '00000000-0000-4000-8000-000000000003', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('db', { query })
  app.decorate('audit', { log: vi.fn(async () => {}) })
  return app
}

describe('rotas de condições comerciais', () => {
  it('lista histórico por tenant e não expõe o PATCH financeiro legado', async () => {
    const query = vi.fn(async (sql) => {
      if (String(sql).includes('FROM marca_condicoes_comerciais')) return {
        rows: [{ id: 'condition-1', inicio_vigencia: '2026-08-01', fixo_mensal: '1000.00', revision: 1 }],
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(marcasRoutes)

    const history = await app.inject({ method: 'GET', url: `/v1/marcas/${marcaId}/condicoes` })
    expect(history.statusCode).toBe(200)
    expect(history.json()[0]).toMatchObject({
      inicio_vigencia: '2026-08-01',
      competencia: '2026-08',
      fixo_mensal: 1000,
    })

    const patch = await app.inject({
      method: 'PATCH', url: `/v1/marcas/${marcaId}`,
      payload: { comissao_franquia_pct: 8 },
    })
    expect(patch.statusCode).toBe(409)
    expect(patch.json()).toMatchObject({ code: 'USE_MARCA_CONDITION_ENDPOINT' })
    await app.close()
  })

  it('exige revisão e chave de idempotência antes da confirmação', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const app = buildApp(query)
    await app.register(marcasRoutes)
    const response = await app.inject({
      method: 'POST', url: `/v1/marcas/${marcaId}/condicoes`,
      payload: { inicio_vigencia: '2026-09', fixo_mensal: 1200, comissao_franquia_pct: 8 },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'EXPECTED_REVISION_REQUIRED' })
    await app.close()
  })

  it('cria a condição baseline na mesma transação para marca sem cliente', async () => {
    const inserted = {
      id: marcaId, tenant_id: tenantId, cliente_id: null, nome: 'Marca parceira',
      tipo: 'parceira', status: 'ativa', tipo_cobranca: 'fixo_mais_comissao',
      valor_fixo_minimo: 900, comissao_franquia_pct: 7, comissao_franqueadora_pct: 1,
    }
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('WITH nova_marca') && text.includes('INSERT INTO marcas')) return { rows: [inserted] }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(marcasRoutes)
    const response = await app.inject({
      method: 'POST', url: '/v1/marcas',
      payload: {
        nome: 'Marca parceira', tipo: 'parceira', valor_fixo_minimo: 900,
        comissao_franquia_pct: 7, comissao_franqueadora_pct: 1,
      },
    })
    expect(response.statusCode).toBe(201)
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('WITH nova_marca'))
    expect(String(insert?.[0])).toContain('INSERT INTO marca_condicoes_comerciais')
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']))
    await app.close()
  })
})
