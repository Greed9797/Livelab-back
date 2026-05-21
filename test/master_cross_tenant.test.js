import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

import { franqueadoRoutes } from '../src/routes/franqueado.js'

const MASTER_TENANT = '00000000-0000-0000-0000-000000000099'
const OTHER_TENANT = '00000000-0000-0000-0000-000000000001'

function buildApp({
  papel = 'franqueador_master',
  isMaster = true,
  allowedTenantIds = null,
  queryImpl,
} = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: MASTER_TENANT, papel, sub: 'user-master' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
  })
  app.decorate('requireTenantAccess', async (request) => {
    request.isMaster = isMaster
    request.allowedTenantIds = allowedTenantIds
  })
  const queryMock = queryImpl ?? vi.fn().mockResolvedValue({ rows: [] })
  app.decorate('db', { query: queryMock })
  return { app, queryMock }
}

describe('GET /v1/master/ranking', () => {
  it('200 array com items mapeados quando master', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          id: OTHER_TENANT,
          nome: 'Unidade A',
          gmv_mes: 5000,
          gmv_mes_anterior: 4000,
          total_lives: 10,
          total_clientes_ativos: 8,
          total_clientes_ant: 6,
        },
      ],
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(franqueadoRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/master/ranking?periodo=2026-05' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toMatchObject({
      posicao: 1,
      tenant_id: OTHER_TENANT,
      tenant_nome: 'Unidade A',
      gmv_mes: 5000,
      total_lives: 10,
    })
    await app.close()
  })

  it('403 quando papel não-master', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(franqueadoRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/master/ranking' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('GET /v1/public/ranking', () => {
  it('returns only safe public fields without authentication', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          id: OTHER_TENANT,
          nome: 'Unidade A',
          gmv_mes: 5000,
          gmv_mes_anterior: 4000,
          total_lives: 10,
          total_clientes_ativos: 8,
          total_clientes_ant: 6,
        },
      ],
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(franqueadoRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/public/ranking?periodo=2026-05' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body[0]).toEqual({
      posicao: 1,
      nome: 'Unidade A',
      logo_url: null,
      cidade: null,
      uf: null,
      meta_gmv: null,
      gmv_mes: 5000,
      crescimento_pct: 25,
      total_lives: 10,
      total_clientes_ativos: 8,
    })
    expect(body[0]).not.toHaveProperty('tenant_id')
    expect(body[0]).not.toHaveProperty('tenant_nome')
    expect(queryMock.mock.calls[0][0]).toContain('COALESCE(t.ranking_publico_uf, t.uf) AS uf')
    expect(queryMock.mock.calls[0][0]).toContain('t.ranking_publico_ativo IS TRUE')
    expect(queryMock.mock.calls[0][0]).toContain('CONCAT_WS')
    expect(queryMock.mock.calls[0][0]).toContain('ranking_publico_nome')
    expect(queryMock.mock.calls[0][0]).toContain("!~* '(teste|test|dev|homolog|staging|t[e3][^[:alpha:]]*st[e3])'")
    expect(queryMock.mock.calls[0][0]).not.toContain('t.estado')
    await app.close()
  })
})

describe('GET /v1/master/unidade/:tenantId/historico', () => {
  it('200 array de meses', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        { mes: '2025-12', gmv: 1000, lives: 2 },
        { mes: '2026-01', gmv: 2000, lives: 4 },
      ],
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(franqueadoRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/master/unidade/${OTHER_TENANT}/historico`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    await app.close()
  })

  it('400 quando tenantId é o próprio do master', async () => {
    const { app } = buildApp()
    await app.register(franqueadoRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/master/unidade/${MASTER_TENANT}/historico`,
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('403 gerente_regional sem o tenant na lista permitida', async () => {
    const { app } = buildApp({
      papel: 'gerente_regional',
      isMaster: false,
      allowedTenantIds: ['11111111-1111-1111-1111-111111111111'],
    })
    await app.register(franqueadoRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/master/unidade/${OTHER_TENANT}/historico`,
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('GET /v1/master/alertas', () => {
  it('200 array (vazio quando nenhum alerta)', async () => {
    // Todas as 4 queries retornam vazio
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(franqueadoRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/master/alertas?periodo=2026-05' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  it('agrega 4 tipos de alertas', async () => {
    let call = 0
    const queryMock = vi.fn(async () => {
      call++
      if (call === 1) {
        return {
          rows: [
            { tenant_id: 't1', nome: 'A', gmv_atual: 100, gmv_anterior: 1000 },
          ],
        }
      }
      if (call === 2) {
        return {
          rows: [{ tenant_id: 't2', nome: 'B', ultima_live: null }],
        }
      }
      if (call === 3) {
        return {
          rows: [{ tenant_id: 't3', nome: 'C', total_vencidos: 2, valor_total: 500 }],
        }
      }
      if (call === 4) {
        return {
          rows: [{ tenant_id: 't4', nome: 'D', contrato_id: 'c1', cliente_nome: 'Cli', fim: '2026-06-01' }],
        }
      }
      return { rows: [] }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(franqueadoRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/master/alertas' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const tipos = body.map((a) => a.tipo_alerta)
    expect(tipos).toContain('gmv_queda_30pct')
    expect(tipos).toContain('sem_lives_7dias')
    expect(tipos).toContain('boleto_vencido')
    expect(tipos).toContain('contrato_expirando_30dias')
    await app.close()
  })

  it('403 quando papel não-master', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(franqueadoRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/master/alertas' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

// ─── /v1/master/crm — agregação cross-tenant real (W3-C) ──────────────────
describe('GET /v1/master/crm', () => {
  it('200 com is_placeholder=false e pipeline real (8 stages)', async () => {
    let call = 0
    const queryMock = vi.fn(async () => {
      call++
      // 1: summary legado
      if (call === 1) {
        return {
          rows: [
            {
              total_leads: 12,
              estimated_value: '15000.00',
              lead_pool: 4,
              engaged_leads: 6,
              expired_leads: 2,
            },
          ],
        }
      }
      // 2: stage agg
      if (call === 2) {
        return {
          rows: [
            { stage: 'lead_novo', count: 5, value: '5000' },
            { stage: 'ganho', count: 2, value: '8000' },
          ],
        }
      }
      // 3: per-tenant top
      if (call === 3) {
        return {
          rows: [
            {
              stage: 'lead_novo',
              tenant_id: OTHER_TENANT,
              tenant_nome: 'Unidade A',
              count: 3,
              value: '3000',
            },
          ],
        }
      }
      // 4: totals
      if (call === 4) {
        return {
          rows: [
            {
              leads_total: 12,
              valor_total: '15000',
              leads_ultimos_7d: 4,
              ganhos_30d: 2,
              leads_30d: 10,
            },
          ],
        }
      }
      // 5: motivo_perda top
      if (call === 5) return { rows: [{ motivo_perda: 'concorrente', qtd: 3 }] }
      // 6+: fetchUnitSummaries (units) — vazio para simplificar
      return { rows: [] }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(franqueadoRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/master/crm?periodo=2026-05' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.is_placeholder).toBe(false)
    expect(body.pipeline).toHaveLength(8)
    const leadNovo = body.pipeline.find((p) => p.stage_id === 'lead_novo')
    expect(leadNovo.count).toBe(5)
    expect(leadNovo.value).toBe(5000)
    expect(leadNovo.por_tenant).toHaveLength(1)
    expect(leadNovo.por_tenant[0].tenant_nome).toBe('Unidade A')
    // Stages sem dados ainda aparecem com count=0
    const perdido = body.pipeline.find((p) => p.stage_id === 'perdido')
    expect(perdido.count).toBe(0)
    expect(body.totals.leads_total).toBe(12)
    expect(body.totals.taxa_ganhos_30d).toBe(20)
    expect(body.totals.motivo_perda_top).toBe('concorrente')
    await app.close()
  })

  it('gerente_regional restringe agregação ao allowedTenantIds', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({
      papel: 'gerente_regional',
      isMaster: false,
      allowedTenantIds: ['t1', 't2'],
      queryImpl: queryMock,
    })
    await app.register(franqueadoRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/master/crm' })
    expect(res.statusCode).toBe(200)
    expect(res.json().is_placeholder).toBe(false)
    // Pelo menos uma query deve ter recebido o array allowedTenantIds.
    const calls = queryMock.mock.calls.filter((c) =>
      c[1]?.some(
        (p) => Array.isArray(p) && p.includes('t1') && p.includes('t2')
      )
    )
    expect(calls.length).toBeGreaterThan(0)
    await app.close()
  })
})
