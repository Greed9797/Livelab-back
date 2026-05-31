import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { homeRoutes } from '../src/routes/home.js'

function buildApp(queryMock, tenantId = 'tenant-a') {
  const app = Fastify()
  const release = vi.fn()
  const tenantIds = []

  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    tenantIds.push(tenantId)
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return { app, release, tenantIds }
}

function createHomeQueryMock() {
  return vi.fn(async (sql, params = []) => {
    if (sql.includes('COUNT(*) FILTER') && sql.includes('FROM cabines')) {
      return { rows: [{ ao_vivo: '1', operacionais: '7' }] }
    }
    if (sql.includes('home_gmv_operacional')) {
      return { rows: [{ gmv_total_mes: '1600.50', gmv_lives_mes: '1200.50', gmv_videos_mes: '400.00', pedidos_lives_mes: '2', pedidos_videos_mes: '4', pedidos_total_mes: '6', videos_mes: '4', gmv_mes_anterior: '1000.00' }] }
    }
    if (sql.includes('ranking_marcas_mes')) {
      return { rows: [{ marca_id: 'marca-1', nome: 'Marca A', gmv: '1200.50', lives: '2' }] }
    }
    if (sql.includes('FROM live_requests lr')) {
      throw new Error('Home operacional não deve usar live_requests')
    }
    if (sql.includes('combined.apresentadora_id')) {
      return { rows: [{ apresentadora_id: 'ap-1', apresentadora_nome: 'Edja', gmv_total: '800', gmv_lives: '800', gmv_videos: '0', total_lives: '1', pedidos: '8', fixo: '2700', comissao_variavel: '16', total_recebido: '2716' }] }
    }
    if (sql.includes('FROM agenda_eventos ae')) {
      return { rows: [{ id: 'ag-1', tipo: 'live', status: 'confirmado', data_inicio: '2026-05-18T14:00:00.000Z', data_fim: '2026-05-18T16:00:00.000Z', cabine_numero: 2, cabine_nome: 'Cabine 02', marca_nome: 'Marca B', cliente_nome: 'Cliente B', apresentadora_nome: 'Ana' }] }
    }
    if (sql.includes('SUM(valor_fixo)')) return { rows: [{ valor: '1000' }] }
    if (sql.includes('SUM(l.fat_gerado *')) return { rows: [{ valor: '100' }] }
    if (sql.includes('FROM custos')) return { rows: [{ valor: '50' }] }
    if (sql.includes('FROM cabines c')) {
      return {
        rows: [{
          numero: 1,
          id: 'cabine-1',
          status: 'ao_vivo',
          live_atual_id: 'live-1',
          iniciado_em: new Date(Date.now() - 30 * 60_000).toISOString(),
          cliente_nome: 'Marca A',
          apresentador: 'Ana',
          viewer_count: '42',
          total_orders: '5',
          gmv_atual: '350.25',
          horas_contratadas: '0',
          horas_realizadas_hoje: '0',
          apresentadores_extra: [],
        }],
      }
    }
    if (sql.includes('COUNT(*) AS total FROM clientes') && sql.includes('criado_em')) return { rows: [{ total: '1' }] }
    if (sql.includes('COUNT(*) AS total FROM clientes')) return { rows: [{ total: '3' }] }
    if (sql.includes('COUNT(id) AS lives_mes')) return { rows: [{ lives_mes: '2' }] }
    if (sql.includes('gmv_lives_mes_anterior')) return { rows: [{ gmv_lives_mes_anterior: '1000.00' }] }
    if (sql.includes('COUNT(id) AS lives_hoje')) return { rows: [{ lives_hoje: '3' }] }
    if (sql.includes('AVG(viewer_count)')) return { rows: [{ media: '38' }] }
    if (sql.includes('pipeline_aberto')) return { rows: [{ pipeline_aberto: '4', valor_pipeline: '5000' }] }
    if (sql.includes('total_fechados')) return { rows: [{ ganhos: '1', total_fechados: '2' }] }
    if (sql.includes('lives_sem_snapshot_recente')) {
      return {
        rows: [{
          inadimplentes: '0',
          contratos_aguardando_assinatura: '0',
          agendamentos_semana: '2',
          leads_parados: '1',
          conflitos_agenda: '0',
          contratos_analise: '0',
          boletos_vencidos: '0',
          leads_disponiveis: '0',
          cabines_manutencao: '0',
          lives_sem_apresentador: '0',
          lives_abertas_mais_4h: '0',
          lives_sem_snapshot_recente: '0',
        }],
      }
    }
    return { rows: [] }
  })
}

describe('home dashboard', () => {
  it('scopes operational counts and rankings by tenant and returns live commerce fields', async () => {
    const queryMock = createHomeQueryMock()
    const { app, release, tenantIds } = buildApp(queryMock)
    await app.register(homeRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/home/dashboard' })
    const payload = response.json()

    expect(response.statusCode).toBe(200)
    expect(tenantIds).toEqual(['tenant-a'])
    expect(release).toHaveBeenCalledTimes(1)
    expect(payload.ocupacao_cabines_hoje).toEqual({ ao_vivo: 1, operacionais: 7 })
    expect(payload.gmv_total_mes).toBe(1600.5)
    expect(payload.gmv_mes).toBe(1600.5)
    expect(payload.gmv_lives_mes).toBe(1200.5)
    expect(payload.gmv_videos_mes).toBe(400)
    expect(payload.videos_mes).toBe(4)
    expect(payload.gmv_ao_vivo_agora).toBe(350.25)
    expect(payload.lives_ativas_agora).toBe(1)
    expect(payload.lives_hoje).toBe(3)
    expect(payload.ticket_medio_live_mes).toBe(600.25)
    expect(payload.variacao_gmv_mes_anterior_pct).toBe(60.1)
    expect(payload.agenda_hoje).toHaveLength(1)
    expect(payload.ranking_marcas_mes[0]).toMatchObject({ nome: 'Marca A', gmv: 1200.5, lives: 2 })
    expect(payload.ranking_apresentadoras_mes[0]).toMatchObject({ nome: 'Edja', gmv: 800, lives: 1, fixo: 2700, comissao_variavel: 16, total_recebido: 2716 })

    const sqls = queryMock.mock.calls.map(([sql]) => sql)
    const ocupacaoSql = sqls.find((sql) => sql.includes('COUNT(*) FILTER') && sql.includes('FROM cabines'))
    expect(ocupacaoSql).toContain("l.status = 'em_andamento'")

    const cabinesSql = sqls.find((sql) => sql.includes('FROM cabines c'))
    expect(cabinesSql).toContain("l.status = 'em_andamento'")

    const gmvSql = sqls.find((sql) => sql.includes('home_gmv_operacional'))
    expect(gmvSql).toContain('FROM vendas_atribuidas va')
    expect(gmvSql).toContain("va.origem = 'video'")

    const rankingSql = sqls.find((sql) => sql.includes('ranking_marcas_mes'))
    expect(rankingSql).toContain('FROM lives l')
    expect(rankingSql).toContain("COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)")
    expect(rankingSql).toContain("va.origem = 'video'")
    expect(rankingSql).toContain("date_trunc('month'")

    expect(sqls.some((sql) => sql.includes('proximas_lives_operacionais'))).toBe(false)
    const agendaSql = sqls.find((sql) => sql.includes('SELECT ae.id, ae.tipo') && sql.includes('FROM agenda_eventos ae'))
    expect(agendaSql).toContain('a_evento.id = ae.apresentadora_id')
    const rankingApSql = sqls.find((sql) => sql.includes('combined.apresentadora_id'))
    expect(rankingApSql).toContain('FROM lives l')
    expect(rankingApSql).toContain("va.origem = 'video'")
    expect(rankingApSql).toContain('COALESCE(ap_v2.apresentadora_id, ap_user.id)')
    expect(rankingApSql).toContain('MAX(')
    expect(queryMock.mock.calls.some(([, params]) => Array.isArray(params) && params.includes('tenant-a'))).toBe(true)

    await app.close()
  })

  it('adds private cache/timing headers and serves repeated requests from cache', async () => {
    const queryMock = createHomeQueryMock()
    const { app } = buildApp(queryMock, 'tenant-cache')
    await app.register(homeRoutes)

    const first = await app.inject({ method: 'GET', url: '/v1/home/dashboard' })
    const callsAfterFirst = queryMock.mock.calls.length
    const second = await app.inject({ method: 'GET', url: '/v1/home/dashboard' })

    expect(first.statusCode).toBe(200)
    expect(first.headers['x-home-dashboard-cache']).toBe('MISS')
    expect(first.headers['cache-control']).toContain('private')
    expect(first.headers['cache-control']).toContain('max-age=15')
    expect(first.headers['server-timing']).toContain('total;dur=')
    expect(second.statusCode).toBe(200)
    expect(second.headers['x-home-dashboard-cache']).toBe('HIT')
    expect(queryMock.mock.calls.length).toBe(callsAfterFirst)

    await app.close()
  })

  it('deduplicates simultaneous dashboard requests for the same tenant', async () => {
    const baselineMock = createHomeQueryMock()
    const baseline = buildApp(baselineMock, 'tenant-baseline')
    await baseline.app.register(homeRoutes)
    await baseline.app.inject({ method: 'GET', url: '/v1/home/dashboard' })
    const singleRequestQueryCount = baselineMock.mock.calls.length
    await baseline.app.close()

    const queryMock = createHomeQueryMock()
    const { app } = buildApp(queryMock, 'tenant-inflight')
    await app.register(homeRoutes)

    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/home/dashboard' }),
      app.inject({ method: 'GET', url: '/v1/home/dashboard' }),
    ])

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(queryMock.mock.calls.length).toBe(singleRequestQueryCount)

    await app.close()
  })
})
