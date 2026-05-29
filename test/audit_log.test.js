import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

import { auditLogRoutes } from '../src/routes/audit_log.js'

const TENANT = '00000000-0000-0000-0000-000000000001'

function buildApp({ papel = 'auditor', queryImpl } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (req) => {
    req.user = { tenant_id: TENANT, papel, sub: 'u1' }
  })
  app.decorate('requirePapel', (papeis) => async (req, reply) => {
    if (!req.user) req.user = { tenant_id: TENANT, papel, sub: 'u1' }
    if (!papeis.includes(req.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  const queryMock = queryImpl ?? vi.fn(async (sql) => {
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: '0' }] }
    return { rows: [] }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query: queryMock, release: () => {} }))
  return { app, queryMock }
}

describe('GET /v1/audit-log', () => {
  it('200 com itens + total + paginação default quando auditor', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: '2' }] }
      return {
        rows: [
          { id: 'a1', action: 'user.login', entity_type: 'user', autor_nome: 'X' },
          { id: 'a2', action: 'user.login', entity_type: 'user', autor_nome: 'Y' },
        ],
      }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(auditLogRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/audit-log' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.itens).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(body.pagina).toBe(1)
    expect(body.por_pagina).toBe(50)
    await app.close()
  })

  it('aceita filtros action/desde/pagina e injeta tenant_id no WHERE', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: '0' }] }
      return { rows: [] }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(auditLogRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit-log?action=user.login&desde=2026-01-01T00:00:00Z&pagina=2&por_pagina=10',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pagina).toBe(2)
    expect(body.por_pagina).toBe(10)
    // Confirma tenant_id no WHERE
    const sqls = queryMock.mock.calls.map((c) => c[0])
    expect(sqls.some((s) => /a\.tenant_id = \$1::uuid/.test(s))).toBe(true)
    await app.close()
  })

  it('suporta wildcard LIKE quando action contém %', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: '0' }] }
      return { rows: [] }
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(auditLogRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit-log?action=user.%25',
    })
    expect(res.statusCode).toBe(200)
    const sqls = queryMock.mock.calls.map((c) => c[0])
    expect(sqls.some((s) => /a\.action LIKE/.test(s))).toBe(true)
    await app.close()
  })

  it('403 quando papel sem READ_AUDIT_LOG (gerente)', async () => {
    const { app } = buildApp({ papel: 'gerente' })
    await app.register(auditLogRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/audit-log' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('400 quando user_id inválido (não UUID)', async () => {
    const { app } = buildApp()
    await app.register(auditLogRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/audit-log?user_id=nao-uuid' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
