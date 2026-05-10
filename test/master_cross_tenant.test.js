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
