import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { livesRoutes } from '../src/routes/lives.js'

const tenantId = '11111111-1111-4111-8111-111111111111'

function buildApp({ lives = [], pending = [], role = 'franqueado' } = {}) {
  const app = Fastify()
  const calls = []

  const query = vi.fn(async (sql, params = []) => {
    const text = String(sql)
    calls.push({ sql: text, params })
    return { rows: text.includes('SELECT s.*, TRUE AS pendente_aprovacao') ? pending : lives }
  })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: role }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })
  app.decorate('cache', { invalidate: async () => {}, get: async () => null, set: async () => {} })

  return { app, query, calls }
}

describe('GET /v1/lives/resumo-dia', () => {
  it('includes pending detail but does not double count collisions', async () => {
    const { app, calls } = buildApp({ lives: [{ gmv: 100 }], pending: [
      { id: 'safe', status: 'pendente', pendente_aprovacao: true, gmv_declarado: '19.99' },
      { id: 'collision', status: 'pendente', pendente_aprovacao: true, em_conciliacao: true, gmv_declarado: '100' },
    ] })
    await livesRoutes(app)
    const response = await app.inject({ method: 'GET', url: '/v1/lives/resumo-dia?data=2026-09-11' })
    expect(response.statusCode).toBe(200)
    expect(response.json().totais).toMatchObject({ gmv: 100, gmv_pendente_aprovacao: 119.99, total_provisorio: null, em_conciliacao: true })
    expect(response.json().texto_whatsapp).toContain('Sem comissão antes da validação')
    const pendingCall = calls.find((c) => String(c.sql).includes('apresentadora_live_submissoes'))
    expect(pendingCall.params.slice(0, 3)).toEqual([tenantId, '2026-09-11', '2026-09-12'])
    const mesCall = calls.find((c) => String(c.params?.[1] ?? '').startsWith('2026-09-01'))
    expect(mesCall?.params.slice(0, 3)).toEqual([tenantId, '2026-09-01T00:00:00 America/Sao_Paulo', '2026-09-12T00:00:00 America/Sao_Paulo'])
    await app.close()
  })
  it('rejects invalid date format with 400', async () => {
    const { app } = buildApp()
    await livesRoutes(app)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/lives/resumo-dia?data=invalid-date',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('error', 'Informe uma data válida (YYYY-MM-DD).')
  })

  it('returns aggregated day summary and formatted whatsapp text', async () => {
    const mockLives = [
      {
        id: 'live-1',
        iniciado_em: '2026-09-11T13:00:00-03:00',
        encerrado_em: '2026-09-11T15:00:00-03:00',
        gmv: 4500,
        pedidos: 35,
        marca_nome: 'Rovitex',
        apresentadora_nome: 'Sandy',
      },
      {
        id: 'live-2',
        iniciado_em: '2026-09-11T16:00:00-03:00',
        encerrado_em: '2026-09-11T18:00:00-03:00',
        gmv: 3500,
        pedidos: 25,
        marca_nome: 'Malwee',
        apresentadoras: [
          {
            nome: 'Sandy',
            papel: 'principal',
            gmv: 2100,
            segundos: 4320,
          },
          {
            nome: 'Bia',
            papel: 'apoio',
            gmv: 1400,
            segundos: 2880,
          },
        ],
      },
    ]

    const { app, calls } = buildApp({ lives: mockLives })
    await livesRoutes(app)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/lives/resumo-dia?data=2026-09-11',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.data).toBe('2026-09-11')
    expect(body.totais.gmv).toBe(8000)
    expect(body.totais.pedidos).toBe(60)
    expect(body.totais.horas_formatadas).toBe('4h 00min')
    expect(body.totais.gmv_por_hora).toBe(2000)
    expect(body.totais.lives_count).toBe(2)

    expect(body.marcas).toHaveLength(2)
    expect(body.marcas[0].nome).toBe('Rovitex')
    expect(body.marcas[0].gmv).toBe(4500)
    expect(body.marcas[0].pedidos).toBe(35)
    expect(body.marcas[0].gmv_por_hora).toBe(2250)

    expect(body.apresentadoras).toHaveLength(2)
    expect(body.apresentadoras[0].nome).toBe('Sandy')
    expect(body.apresentadoras[0].gmv).toBe(6600)

    expect(body.texto_whatsapp).toContain('📊 *RESUMO DO DIA — LIVES*')
    expect(body.texto_whatsapp).toContain('💰 *GMV Total:*')
    expect(body.texto_whatsapp).toContain('⚡ *GMV/h:*')
    expect(body.texto_whatsapp).toContain('🏷️ *POR MARCA*')
    expect(body.texto_whatsapp).toContain('🎤 *POR APRESENTADORA*')
    expect(body.texto_whatsapp).not.toContain('visualiza')
    expect(body.texto_whatsapp).not.toContain('impress')
    expect(body.texto_whatsapp).not.toContain('pedidos')
    expect(body.totais.acumulado_mes).toBe(8000)

    expect(calls[0].sql).toContain('l.manual_views')
    expect(calls[0].sql).toContain('l.final_peak_viewers')
    expect(calls[0].sql).toContain('l.live_impressions')
    expect(calls[0].sql).toMatch(/va_marca\.marca_id/)
    expect(calls[0].sql).toMatch(/m\.id AS marca_id/)
    expect(calls[0].params[0]).toBe(tenantId)
  })
})
