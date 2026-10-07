import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { analyticsOperacionalRoutes } from '../src/routes/analytics-operacional.js'

describe('analytics operational input validation', () => {
  it('returns 400 for a null presenter floor instead of throwing 500', async () => {
    const app = Fastify()
    app.decorate('requirePapel', () => async request => {
      request.user = { tenant_id: '11111111-1111-4111-8111-111111111111', sub: 'user', papel: 'gerente' }
    })
    app.decorate('withTenant', vi.fn())
    app.decorate('audit', { log: vi.fn() })
    await app.register(analyticsOperacionalRoutes)
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/analytics/metas-operacionais',
      payload: {
        ano_mes: '2026-10',
        meta_gmv: 600000,
        meta_gmv_hora: 300,
        configuracao: { horas_por_apresentador: 5.5, cabines_consideradas: 6, turnos: [{ inicio: '08:00', fim: '19:00' }] },
        pisos_apresentadoras: [null],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(app.withTenant).not.toHaveBeenCalled()
    await app.close()
  })
})
