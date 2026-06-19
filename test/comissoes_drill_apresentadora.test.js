import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { comissoesRoutes } from '../src/routes/comissoes.js'

function buildApp(queryMock) {
  const app = Fastify()
  const releaseMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('db', { query: queryMock })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return app
}

describe('GET /v1/comissoes/por-apresentadora/:id', () => {
  it('returns per-live commission aggregated for the apresentadora', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        { live_id: 'live-1', gmv: '41200', comissao_apresentadora: '824', pct_aplicado: '2.00' },
        { live_id: 'live-2', gmv: '28900', comissao_apresentadora: '433.5', pct_aplicado: '1.50' },
      ],
    })

    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const apId = 'apres-uuid-1'
    const response = await app.inject({
      method: 'GET',
      url: `/v1/comissoes/por-apresentadora/${apId}?data_inicio=2026-06-01&data_fim=2026-06-30`,
    })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(payload.apresentadora_id).toBe(apId)
    expect(payload.lives).toHaveLength(2)
    expect(payload.lives[0]).toMatchObject({ live_id: 'live-1', gmv: 41200, comissao_apresentadora: 824, pct_aplicado: 2 })

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain("va.origem = 'live'")
    expect(sql).toContain('va.apresentadora_id = $2::uuid')
    expect(sql).toContain('GROUP BY va.origem_id')
    // período opcional aplicado como guarda NULL
    expect(sql).toContain('$3::date IS NULL OR va.data >= $3::date')
    // reconcilia com o KpiHero (performance-rollups exclui reprovada)
    expect(sql).toContain("<> 'reprovada'")
  })
})

describe('GET /v1/comissoes/memoria', () => {
  it('returns per-line calc memory with faixa, base GMV and weekend flag', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'va-1',
          data: '2026-06-28',
          origem: 'live',
          gmv: '41200',
          comissao_apresentadora: '824',
          pct_aplicado: '2.00',
          marca_nome: 'Boca Rosa',
          base_gmv_mes: '324200',
          faixa_gmv_inicio: '150000',
          faixa_gmv_fim: '500000',
          faixa_pct: '1.5',
          fim_de_semana: true,
        },
      ],
    })

    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/comissoes/memoria?apresentadora_id=apres-uuid-1&data_inicio=2026-06-01&data_fim=2026-06-30',
    })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(payload.apresentadora_id).toBe('apres-uuid-1')
    expect(payload.total_variavel).toBe(824)
    expect(payload.linhas).toHaveLength(1)
    expect(payload.linhas[0]).toMatchObject({
      gmv: 41200,
      comissao_apresentadora: 824,
      pct_aplicado: 2,
      base_gmv_mes: 324200,
      fim_de_semana: true,
      faixa: { gmv_inicio: 150000, gmv_fim: 500000, comissao_pct: 1.5 },
    })

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain('apresentadora_comissao_faixas')
    expect(sql).toContain("date_trunc('month'")
    expect(sql).toContain('EXTRACT(DOW FROM va.data)')
    expect(sql).toContain("<> 'reprovada'")
  })

  it('keeps faixa null when no tier matched', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ id: 'va-2', data: '2026-06-10', origem: 'video', gmv: '1000', comissao_apresentadora: '5', pct_aplicado: '0.50', marca_nome: 'X', base_gmv_mes: '1000', faixa_gmv_inicio: null, faixa_gmv_fim: null, faixa_pct: null, fim_de_semana: false }],
    })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/comissoes/memoria?apresentadora_id=apres-uuid-1' })
    expect(response.statusCode).toBe(200)
    expect(response.json().linhas[0].faixa).toBeNull()
  })

  it('returns 400 when apresentadora_id is missing', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/comissoes/memoria' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: expect.stringContaining('apresentadora_id') })
    expect(queryMock).not.toHaveBeenCalled()
  })
})
