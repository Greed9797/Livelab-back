import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { analyticsRoutes } from '../src/routes/analytics.js'
import { metaUnidadeRoutes } from '../src/routes/meta_unidade.js'

const tenantId = '11111111-1111-4111-8111-111111111111'

function buildApp(queryMock, { papel = 'franqueado' } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query: queryMock }))
  app.decorate('audit', { log: vi.fn().mockResolvedValue() })
  return app
}

afterEach(() => vi.useRealTimers())

describe('metas mensais da unidade', () => {
  it('preserva a meta GMV existente ao atualizar somente horas e GMV/h', async () => {
    const queryMock = vi.fn(async (sql, params) => {
      expect(sql).toContain('ON CONFLICT (tenant_id, ano_mes) DO UPDATE')
      expect(sql).toContain('CASE WHEN $6::boolean')
      expect(sql).toContain('CASE WHEN $7::boolean')
      expect(sql).toContain('CASE WHEN $8::boolean')
      expect(params).toEqual([tenantId, '2026-09', null, 1100, 550, false, true, true])
      return { rows: [{ ano_mes: '2026-09', meta_gmv: '85000', meta_horas_live: '1100', meta_gmv_hora: '550' }] }
    })
    const app = buildApp(queryMock)
    await app.register(metaUnidadeRoutes)

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/meta-unidade',
      payload: { ano_mes: '2026-09', meta_horas_live: 1100, meta_gmv_hora: 550 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ano_mes: '2026-09', meta_gmv: 85000, meta_horas_live: 1100, meta_gmv_hora: 550,
    })
    expect(app.audit.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      metadata: { ano_mes: '2026-09', meta_horas_live: 1100, meta_gmv_hora: 550 },
    }))
    await app.close()
  })

  it('permite limpar explicitamente apenas uma das metas novas', async () => {
    const queryMock = vi.fn(async (_sql, params) => {
      expect(params).toEqual([tenantId, '2026-09', null, null, null, false, true, false])
      return { rows: [{ ano_mes: '2026-09', meta_gmv: '85000', meta_horas_live: null, meta_gmv_hora: '550' }] }
    })
    const app = buildApp(queryMock)
    await app.register(metaUnidadeRoutes)

    const res = await app.inject({ method: 'PUT', url: '/v1/meta-unidade', payload: { ano_mes: '2026-09', meta_horas_live: null } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ meta_gmv: 85000, meta_horas_live: null, meta_gmv_hora: 550 })
    await app.close()
  })

  it('aceita números JavaScript válidos com duas casas, apesar do ruído binário', async () => {
    const queryMock = vi.fn(async (_sql, params) => {
      expect(params).toEqual([tenantId, '2026-09', 9876543.21, null, 0.29, true, false, true])
      return { rows: [{ ano_mes: '2026-09', meta_gmv: '9876543.21', meta_horas_live: null, meta_gmv_hora: '0.29' }] }
    })
    const app = buildApp(queryMock)
    await app.register(metaUnidadeRoutes)

    const res = await app.inject({ method: 'PUT', url: '/v1/meta-unidade', payload: { ano_mes: '2026-09', meta_gmv: 9876543.21, meta_gmv_hora: 0.29 } })

    expect(res.statusCode).toBe(200)
    expect(res.json().meta_gmv).toBe(9876543.21)
    expect(res.json().meta_gmv_hora).toBe(0.29)
    await app.close()
  })

  it.each([
    { meta_gmv: null },
    { meta_gmv: true },
    { meta_horas_live: ' ' },
    { meta_gmv_hora: 550.123 },
  ])('rejeita valores de meta ambíguos ou com precisão inválida: %o', async (payload) => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(metaUnidadeRoutes)

    const res = await app.inject({ method: 'PUT', url: '/v1/meta-unidade', payload })

    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('calcula a projeção do mês atual por dias corridos em São Paulo', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-06T15:00:00.000Z')) // meio-dia em São Paulo
    const queryMock = vi.fn(async (sql, params) => {
      if (sql.includes('FROM lives l')) {
        expect(sql).toContain("l.status = 'encerrada'")
        expect(sql).toContain("l.iniciado_em >= ($1::timestamp) AT TIME ZONE 'America/Sao_Paulo'")
        expect(params).toEqual(['2026-09-01', '2026-09-06'])
        // Duração bruta fracionada: a API não pode arredondar antes de dividir
        // ou projetar (220.004h × R$550/h).
        return { rows: [{ horas_live: '220.004', gmv: '121002.2' }] }
      }
      expect(sql).toContain('FROM meta_unidade')
      expect(params).toEqual([tenantId, '2026-09'])
      return { rows: [{ meta_horas_live: '1100', meta_gmv_hora: '550' }] }
    })
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/analytics/unidade-mensal?ano_mes=2026-09' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      ano_mes: '2026-09',
      escopo: 'unidade',
      periodo: { inicio: '2026-09-01', fim: '2026-09-30', dias_no_mes: 30, dias_decorridos: 6 },
      realizado: { horas_live: 220, gmv: 121002.2, gmv_por_hora: 550 },
      projecao: { horas_live: 1100.02, gmv: 605011, gmv_por_hora: 550 },
      metas: { horas_live: 1100, gmv_por_hora: 550 },
    })
    await app.close()
  })

  it('não projeta mês encerrado ou futuro e não expõe metas a outro papel', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-06T15:00:00.000Z'))
    const queryMock = vi.fn(async (sql) => ({
      rows: sql.includes('FROM lives l')
        ? [{ horas_live: '200', gmv: '100000' }]
        : [{ meta_horas_live: null, meta_gmv_hora: null }],
    }))
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const passado = await app.inject({ method: 'GET', url: '/v1/analytics/unidade-mensal?ano_mes=2026-08' })
    const futuro = await app.inject({ method: 'GET', url: '/v1/analytics/unidade-mensal?ano_mes=2026-10' })
    expect(passado.json().periodo.dias_decorridos).toBe(31)
    expect(passado.json().projecao).toBeNull()
    expect(futuro.json().periodo.dias_decorridos).toBe(0)
    expect(futuro.json().projecao).toBeNull()
    await app.close()

    const outroPapel = buildApp(vi.fn(), { papel: 'marketing' })
    await outroPapel.register(analyticsRoutes)
    const forbidden = await outroPapel.inject({ method: 'GET', url: '/v1/analytics/unidade-mensal?ano_mes=2026-09' })
    expect(forbidden.statusCode).toBe(403)
    await outroPapel.close()
  })
})
