// Regressão: GET /v1/comissoes/* aceita ?mes=YYYY-MM e expande pra data range.
// Os rollups usam fim exclusivo para evitar bug de timezone no último dia.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { comissoesRoutes } from '../src/routes/comissoes.js'

const tenantId = '11111111-1111-4111-8111-111111111111'

function buildApp({ queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })

  return { app, query }
}

describe('buildComissaoFilters — mes=YYYY-MM', () => {
  it('expande mes=2026-05 em data >= 2026-05-01 AND data < 2026-06-01', async () => {
    const { app, query } = buildApp()
    await app.register(comissoesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/apresentadoras?mes=2026-05' })
    expect(res.statusCode).toBe(200)

    const call = query.mock.calls.find(([sql]) => String(sql).includes('FROM vendas_atribuidas va'))
    expect(call).toBeTruthy()
    const values = call[1]
    expect(values).toContain('2026-05-01')
    expect(values).toContain('2026-06-01')
    await app.close()
  })

  it('ignora mes inválido (formato errado)', async () => {
    const { app, query } = buildApp()
    await app.register(comissoesRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/apresentadoras?mes=2026-5' })
    expect(res.statusCode).toBe(200)
    const call = query.mock.calls.find(([sql]) => String(sql).includes('FROM vendas_atribuidas va'))
    const values = call[1]
    expect(values).not.toContain('2026-5')
    await app.close()
  })

  it('combina mes + apresentadora_id', async () => {
    const apId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const { app, query } = buildApp()
    await app.register(comissoesRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/comissoes/apresentadoras?mes=2026-02&apresentadora_id=${apId}`,
    })
    expect(res.statusCode).toBe(200)
    const call = query.mock.calls.find(([sql]) => String(sql).includes('FROM vendas_atribuidas va'))
    const values = call[1]
    expect(values).toContain(apId)
    expect(values).toContain('2026-02-01')
    expect(values).toContain('2026-03-01')
    await app.close()
  })

  it('fevereiro 2024 (bissexto) → fim exclusivo em 2024-03-01', async () => {
    const { app, query } = buildApp()
    await app.register(comissoesRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/marcas?mes=2024-02' })
    expect(res.statusCode).toBe(200)
    const call = query.mock.calls.find(([sql]) => String(sql).includes('FROM vendas_atribuidas va'))
    const values = call[1]
    expect(values).toContain('2024-03-01')
    await app.close()
  })
})
