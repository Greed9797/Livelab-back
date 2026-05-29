import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { crmRoutes } from '../src/routes/crm.js'

function buildCrmApp(queryMock) {
  const app = Fastify()
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado', nome: 'Franqueado QA' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return { app, release }
}

describe('GET /v1/crm/summary', () => {
  it('returns tenant scoped CRM metrics in the frontend contract', async () => {
    const queryMock = vi.fn(async (sql, args) => {
      expect(args[0]).toBe('tenant-1')
      expect(sql).toContain('franqueadora_id = $1')
      expect(sql).toContain("status != 'expirado'")

      if (sql.includes('COUNT(*)::int AS total_leads')) {
        return {
          rows: [{
            total_leads: 4,
            valor_pipeline: '1500',
            valor_estimado: '2000',
            ganhos: 1,
            perdidos: 1,
          }],
        }
      }
      if (sql.includes('GROUP BY crm_etapa')) {
        return { rows: [{ etapa: 'lead_novo', total: 2, valor: '500' }] }
      }
      if (sql.includes('GROUP BY COALESCE(NULLIF(origem')) {
        return { rows: [{ origem: 'Cliente', total: 3, valor: '1200' }] }
      }
      if (sql.includes('leads_parados')) {
        return {
          rows: [{
            leads_parados: 1,
            sem_responsavel: 2,
            sem_contato: 1,
            aguardando_assinatura: 1,
          }],
        }
      }
      return { rows: [] }
    })
    const { app, release } = buildCrmApp(queryMock)
    await app.register(crmRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/crm/summary' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      summary: {
        total_leads: 4,
        valor_estimado: 2000,
        ganhos: 1,
        perdidos: 1,
      },
      totals: {
        total_leads: 4,
        valor_pipeline: 1500,
        valor_estimado: 2000,
        ganhos: 1,
        perdidos: 1,
      },
      pipeline: [{ etapa: 'lead_novo', total: 2, valor: 500 }],
      origem: [{ origem: 'Cliente', total: 3, valor: 1200 }],
      alertas: {
        leads_parados: 1,
        sem_responsavel: 2,
        sem_contato: 1,
        aguardando_assinatura: 1,
      },
    })
    expect(release).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
