import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { clientesRoutes } from '../src/routes/clientes.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const clienteId = '22222222-2222-4222-822222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'

function buildApp(query) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user ??= { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    request.user ??= { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (scopeTenantId, fn) => {
    expect(scopeTenantId).toBe(tenantId)
    return fn({ query })
  })
  return app
}

function clienteAtualizado(status) {
  return { rows: [{ id: clienteId, nome: 'Cliente', status, onboarding_step: null, tiktok_username: null, logo_url: null }] }
}

describe('PATCH /v1/clientes/:id lifecycle da marca espelhada', () => {
  it('não reativa marca inativa durante edição comum', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      if (sql.includes('UPDATE clientes SET')) return clienteAtualizado('ativo')
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'inativa' }] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { email: 'novo@example.com' } })

    expect(response.statusCode).toBe(200)
    expect(calls.some((sql) => sql.includes("SET status = 'ativa'"))).toBe(false)
    await app.close()
  })

  it.each([
    ['cancelado', 'inativa'],
    ['arquivado', 'arquivada'],
  ])('sincroniza todas as marcas espelhadas para %s', async (statusCliente, statusMarca) => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      if (sql.includes('UPDATE clientes SET')) return clienteAtualizado(statusCliente)
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'ativa' }] }
      if (sql.includes(`UPDATE marcas SET status = '${statusMarca}'`)) return { rows: [] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { status: statusCliente } })

    expect(response.statusCode).toBe(200)
    const sync = calls.find((sql) => sql.includes(`UPDATE marcas SET status = '${statusMarca}'`))
    expect(sync).toContain('WHERE cliente_id = $1')
    expect(sync).not.toMatch(/\bWHERE\s+id\s*=/)
    await app.close()
  })

  it('reativa somente quando status ativo é enviado explicitamente', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      if (sql.includes('UPDATE clientes SET')) return clienteAtualizado('ativo')
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'inativa' }] }
      if (sql.includes('SELECT status') && sql.includes('FROM clientes')) return { rows: [{ status: 'ativo' }] }
      if (sql.includes("UPDATE marcas") && sql.includes("status = 'ativa'")) return { rows: [{ id: marcaId }] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { status: 'ativo' } })

    expect(response.statusCode).toBe(200)
    expect(calls.some((sql) => sql.includes("SET status = 'ativa'"))).toBe(true)
    await app.close()
  })
})
