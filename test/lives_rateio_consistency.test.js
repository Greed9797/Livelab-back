import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

const events = []
const calcularMock = vi.fn(async () => {
  events.push('engine')
  return []
})

vi.mock('../src/services/commission-engine.js', () => ({
  calcularComissoesDaLive: calcularMock,
}))

const { livesRoutes } = await import('../src/routes/lives.js')

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveId = '22222222-2222-4222-8222-222222222222'
const sandyId = '33333333-3333-4333-8333-333333333333'
const cliceaneId = '44444444-4444-4444-8444-444444444444'

describe('PATCH /v1/lives/:id presenter split consistency', () => {
  it('recalculates attribution before commit and clears the obsolete legacy junction', async () => {
    events.length = 0
    calcularMock.mockClear()
    let deletedLegacy = false
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text === 'BEGIN') {
        events.push('begin')
        return { rows: [] }
      }
      if (text === 'COMMIT') {
        events.push('commit')
        return { rows: [] }
      }
      if (text.includes('FROM lives l') && text.includes('FOR UPDATE OF l')) {
        return {
          rows: [{
            id: liveId,
            status: 'encerrada',
            cabine_id: '55555555-5555-4555-8555-555555555555',
            marca_id: null,
            apresentador_id: null,
            ads_gmv: null,
            manual_gmv: '3234.76',
            fat_gerado: '3234.76',
            final_orders_count: 12,
            iniciado_em: '2026-08-20T12:00:00.000Z',
            encerrado_em: '2026-08-20T16:45:00.000Z',
          }],
        }
      }
      if (text.includes('SELECT COALESCE(ads_gmv, manual_gmv, fat_gerado')) {
        return { rows: [{ gmv: '3234.76', segundos: 17100 }] }
      }
      if (text.includes('DELETE FROM live_apresentadores')) deletedLegacy = true
      return { rows: [] }
    })

    const app = Fastify()
    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
    })
    app.decorate('requirePapel', () => async () => {})
    app.decorate('withTenant', async (_tenantId, fn) => fn({ query }))
    app.decorate('db', { pool: { connect: vi.fn() } })
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}`,
      payload: {
        apresentadoras: [
          { apresentadora_id: sandyId, gmv: 2250.20, segundos: 6300 },
          { apresentadora_id: cliceaneId, gmv: 984.56, segundos: 10800 },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(calcularMock).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      expect.objectContaining({ liveId, tenantId, gmv: 3234.76, pedidos: 12 }),
    )
    expect(events.indexOf('engine')).toBeGreaterThan(events.indexOf('begin'))
    expect(events.indexOf('engine')).toBeLessThan(events.indexOf('commit'))
    expect(deletedLegacy).toBe(true)
    await app.close()
  })
})
