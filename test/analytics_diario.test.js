import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { analyticsRoutes } from '../src/routes/analytics.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const apresentadoraId = '33333333-3333-4333-8333-333333333333'

function buildApp(queryMock) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query: queryMock }))
  return app
}

describe('analytics diario', () => {
  it('propagates pending declarations to dashboard KPIs and temporal series', async () => {
    const queryMock = vi.fn(async sql => ({ rows: sql.includes('SELECT s.*, TRUE AS pendente_aprovacao') ? [{
      id: 's1', marca_id: marcaId, apresentadora_id: apresentadoraId, pendente_aprovacao: true,
      iniciado_em: '2031-09-05T12:00:00Z', encerrado_em: '2031-09-05T13:00:00Z', gmv_declarado: '19.99', pedidos_declarados: 2,
      live_impressions_declaradas: 500, manual_views_declaradas: 100,
    }] : [] }))
    const app = buildApp(queryMock); await app.register(analyticsRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/dashboard?mesAno=2031-09' })
    expect(res.statusCode).toBe(200)
    expect(res.json().kpis).toMatchObject({ gmv_total: 19.99, total_lives: 1, horas_live: 1, pedidos_total: 2, pendente_aprovacao: true, viewers_total: 100, impressoes_pendentes_aprovacao: 500 })
    expect(res.json().gmv_mensal[0]).toMatchObject({ mes: '2031-09', gmv_total: 19.99 })
    expect(res.json().gmv_diario[0]).toMatchObject({ dia: '2031-09-05', gmv_total: 19.99 })
    await app.close()
  })
  it('includes declared reach and views in the funnel, but excludes collisions from combined totals', async () => {
    const queryMock = vi.fn(async sql => ({ rows: sql.includes('SELECT s.*, TRUE AS pendente_aprovacao') ? [
      { id: 's1', pendente_aprovacao: true, iniciado_em: '2026-09-05T12:00Z', encerrado_em: '2026-09-05T13:00Z', gmv_declarado: 20, pedidos_declarados: 2, live_impressions_declaradas: 500, manual_views_declaradas: 100 },
      { id: 's2', pendente_aprovacao: true, em_conciliacao: true, gmv_declarado: 50, live_impressions_declaradas: 200, manual_views_declaradas: 40 },
    ] : [] }))
    const app = buildApp(queryMock); await app.register(analyticsRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/funil?mesAno=2026-09' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ pendente_aprovacao: true, em_conciliacao: true, total_provisorio: null, gmv_pendente_aprovacao: 70 })
    expect(res.json().resumo).toMatchObject({ gmv: 20, total_lives: 1, visualizacoes: 100, pedidos: 2 })
    expect(res.json().etapas[0].valor).toBe(500)
    await app.close()
  })
  it('reports pending-only commission as unknown, not zero', async () => {
    const queryMock = vi.fn(async sql => ({ rows: sql.includes('FROM apresentadora_live_submissoes s') ? [{ dia: '2026-07-28', marca_id: marcaId, apresentadora_id: apresentadoraId, total_lives_pendentes: 1, gmv_pendente: '20', total_envios_pendentes: 1 }] : [] }))
    const app = buildApp(queryMock); await app.register(analyticsRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/diario?mesAno=2026-07' })
    expect(res.statusCode).toBe(200)
    expect(res.json().rows[0].comissao_apresentadora).toBeNull()
    await app.close()
  })
  it('returns daily rows and applies marca/apresentadora filters', async () => {
    const queryMock = vi.fn(async (sql, params = []) => {
      if (sql.includes('FROM apresentadora_live_submissoes s')) {
        expect(params).toEqual(['2026-05-01', '2026-05-31', marcaId, apresentadoraId])
        return { rows: [] }
      }
      expect(sql).not.toContain('generate_series')
      expect(sql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)')
      expect(sql).toContain('($3::uuid IS NULL OR l.marca_id = $3::uuid)')
      expect(sql).toContain('($4::uuid IS NULL OR lav.apresentadora_id = $4::uuid)')
      expect(sql).toContain('ap_v2.gmv_rateado')
      expect(sql).toContain('ap_v2.segundos_rateio')
      expect(sql).toContain('live_sales.pedidos')
      expect(sql).toContain('($4::uuid IS NULL OR COALESCE(ap_v2.apresentadora_id, ap_user.id) = $4::uuid)')
      expect(sql).toContain("va.origem = 'video'")
      expect(sql).toContain('FULL OUTER JOIN video_daily')
      expect(sql).toContain('COALESCE(ld.marca_nome, vd.marca_nome')
      expect(sql).toContain("l.iniciado_em >= ($1::timestamp) AT TIME ZONE 'America/Sao_Paulo'")
      expect(sql).toContain("l.iniciado_em < (($2::timestamp) + INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo'")
      expect(sql).not.toContain("l.iniciado_em >= ($1::date) AT TIME ZONE 'America/Sao_Paulo'")
      expect(params).toEqual(['2026-05-01', '2026-05-31', marcaId, apresentadoraId])
      return {
        rows: [{
          dia: '2026-05-28',
          marca_id: marcaId,
          marca_nome: 'Haag',
          apresentadora_id: apresentadoraId,
          apresentadora_nome: 'Edja',
          total_lives: 2,
          total_videos: 1,
          gmv_lives: '1000.50',
          gmv_videos: '200.25',
          horas_live: '5.5',
          pedidos: 12,
        }],
      }
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'GET',
      url: `/v1/analytics/diario?mesAno=2026-05&marca_id=${marcaId}&apresentadora_id=${apresentadoraId}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      periodo: { from: '2026-05-01', to: '2026-05-31', mesAno: '2026-05' },
      filters: { marca_id: marcaId, apresentadora_id: apresentadoraId },
      rows: [{
        dia: '2026-05-28',
        marca_id: marcaId,
        marca_nome: 'Haag',
        apresentadora_id: apresentadoraId,
        apresentadora_nome: 'Edja',
        gmv_total: 1200.75,
        gmv_lives: 1000.5,
        gmv_videos: 200.25,
        total_lives: 2,
        total_videos: 1,
        horas_live: 5.5,
        gmv_por_live: 600.38,
        // GMV/hora = gmv_lives / horas (1000.50 / 5.5), NÃO gmv_total — vídeo tem
        // horas=0 e inflaria. Antes (errado): 1200.75/5.5 = 218.32.
        gmv_por_hora: 181.91,
        pedidos: 12,
        ticket_medio: 100.06,
      }],
    })
    await app.close()
  })

  it('rejects invalid UUID filters', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics/diario?mesAno=2026-05&marca_id=invalido',
    })

    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('includes pending submissions in operational totals without commission', async () => {
    const queryMock = vi.fn(async (sql) => sql.includes('FROM apresentadora_live_submissoes s')
      ? { rows: [{ dia: '2026-05-28', marca_id: marcaId, marca_nome: 'Haag', apresentadora_id: apresentadoraId, apresentadora_nome: 'Edja', total_lives_pendentes: 1, gmv_pendente: '200', pedidos_pendentes: 2, horas_pendentes: '1', impressoes_pendentes: '500', visualizacoes_pendentes: '100' }] }
      : { rows: [{ dia: '2026-05-28', marca_id: marcaId, marca_nome: 'Haag', apresentadora_id: apresentadoraId, apresentadora_nome: 'Edja', total_lives: 1, total_videos: 0, gmv_lives: '100', gmv_videos: '0', horas_live: '1', pedidos: 1, comissao_apresentadora: '5', comissao_gmv_base: '100' }] })
    const app = buildApp(queryMock); await app.register(analyticsRoutes)
    const res = await app.inject({ method: 'GET', url: `/v1/analytics/diario?mesAno=2026-05&marca_id=${marcaId}&apresentadora_id=${apresentadoraId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().rows[0]).toMatchObject({ gmv_lives: 300, total_lives: 2, pedidos: 3, comissao_apresentadora: 5, gmv_pendente_aprovacao: 200, pendente_aprovacao: true, impressoes_pendentes_aprovacao: 500, visualizacoes_pendentes_aprovacao: 100 })
    await app.close()
  })
})
