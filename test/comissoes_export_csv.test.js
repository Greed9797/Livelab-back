// GET /v1/comissoes/export-csv — relatório CSV pra comissionamento.

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

describe('GET /v1/comissoes/export-csv', () => {
  it('retorna text/csv com header de colunas', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({ queryMock })
    await app.register(comissoesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/export-csv?mes=2026-05' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('comissoes-2026-05.csv')
    expect(res.body).toContain('data,apresentadora,marca,origem,gmv,comissao_apresentadora,comissao_franquia,comissao_franqueadora,status')
    await app.close()
  })

  it('serializa linhas com escape de CSV', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{
        data: '2026-05-15',
        apresentadora_nome: 'Ana, Silva',
        marca_nome: 'Marca "X"',
        origem: 'live',
        gmv: 1500.5,
        comissao_apresentadora: 15.5,
        comissao_franquia: 30,
        comissao_franqueadora: 45,
        status: 'aprovada',
      }],
    })
    const { app } = buildApp({ queryMock })
    await app.register(comissoesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/export-csv?mes=2026-05' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('"Ana, Silva"')
    expect(res.body).toContain('"Marca ""X"""')
    expect(res.body).toContain('1500.50')
    expect(res.body).toContain('aprovada')
    await app.close()
  })

  it('recusa export com mais de 10000 linhas e não devolve CSV parcial', async () => {
    const rows = Array.from({ length: 10001 }, () => ({
      data: '2026-05-01',
      apresentadora_nome: 'Ana',
      marca_nome: 'Marca',
      origem: 'live',
      gmv: 1,
      comissao_apresentadora: 0,
      comissao_franquia: 0,
      comissao_franqueadora: 0,
      status: 'aprovada',
    }))
    const queryMock = vi.fn().mockResolvedValue({ rows })
    const { app } = buildApp({ queryMock })
    await app.register(comissoesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/export-csv?mes=2026-05' })
    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type'] ?? '').not.toContain('text/csv')
    expect(res.json()).toEqual({ error: 'Export limitado a 10000 linhas. Filtre o período.' })
    expect(res.body).not.toContain('data,apresentadora')
    expect(String(queryMock.mock.calls[0][0])).toContain('LIMIT 10001')
    await app.close()
  })

  it('ainda baixa um conjunto dentro do limite', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{
        data: '2026-05-02',
        apresentadora_nome: 'Bia',
        marca_nome: 'Marca',
        origem: 'live',
        gmv: 0,
        comissao_apresentadora: 0,
        comissao_franquia: 0,
        comissao_franqueadora: 0,
        status: 'aprovada',
      }],
    })
    const { app } = buildApp({ queryMock })
    await app.register(comissoesRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/export-csv?mes=2026-05' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body).toContain('0.00')
    await app.close()
  })
})
