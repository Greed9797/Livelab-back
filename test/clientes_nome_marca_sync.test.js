import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { clientesRoutes } from '../src/routes/clientes.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const clienteId = '22222222-2222-4222-8222-222222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'

function buildApp(query) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (scopeTenantId, fn) => {
    expect(scopeTenantId).toBe(tenantId)
    return fn({ query })
  })
  return app
}

function clientPatchResult() {
  return { rows: [{ id: clienteId, nome: 'Cliente Renomeado', status: 'ativo', onboarding_step: null, tiktok_username: null, logo_url: null }] }
}

describe('PATCH /v1/clientes/:id nome → marca operacional', () => {
  it('renomeia somente a marca operacional vinculada na mesma transação', async () => {
    const calls = []
    const query = vi.fn(async (sql, params = []) => {
      calls.push([String(sql), params])
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT nome FROM clientes') && sql.includes('FOR UPDATE')) return { rows: [{ nome: 'Cliente anterior' }] }
      if (sql.includes('UPDATE clientes SET')) return clientPatchResult()
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'ativa' }] }
      if (sql.includes('SELECT 1 FROM marcas') && sql.includes('lower(nome)')) return { rows: [] }
      if (sql.includes('UPDATE marcas SET nome')) return { rows: [{ id: marcaId }] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { nome: 'Cliente Renomeado' } })

    expect(response.statusCode).toBe(200)
    const renameCall = calls.find(([sql]) => sql.includes('UPDATE marcas SET nome'))
    expect(renameCall?.[1]).toEqual(['Cliente Renomeado', marcaId, tenantId, clienteId])
    expect(calls.map(([sql]) => sql).indexOf('BEGIN')).toBeLessThan(calls.map(([sql]) => sql).indexOf('COMMIT'))
    expect(calls.some(([sql]) => sql.includes('WHERE cliente_id = $1 AND tenant_id') && sql.includes("status = 'inativa'"))).toBe(false)
    await app.close()
  })

  it('faz rollback se a sincronização da marca falhar', async () => {
    const failure = new Error('marca indisponível')
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT nome FROM clientes') && sql.includes('FOR UPDATE')) return { rows: [{ nome: 'Cliente anterior' }] }
      if (sql.includes('UPDATE clientes SET')) return clientPatchResult()
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'ativa' }] }
      if (sql.includes('SELECT 1 FROM marcas') && sql.includes('lower(nome)')) return { rows: [] }
      if (sql.includes('UPDATE marcas SET nome')) throw failure
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { nome: 'Cliente Renomeado' } })

    expect(response.statusCode).toBe(500)
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    await app.close()
  })

  it('traduz colisão do nome de marca em 409 e faz rollback', async () => {
    const collision = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uniq_marca_nome_por_tenant' })
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT nome FROM clientes') && sql.includes('FOR UPDATE')) return { rows: [{ nome: 'Cliente anterior' }] }
      if (sql.includes('UPDATE clientes SET')) return clientPatchResult()
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'ativa' }] }
      if (sql.includes('SELECT 1 FROM marcas') && sql.includes('lower(nome)')) return { rows: [] }
      if (sql.includes('UPDATE marcas SET nome')) throw collision
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { nome: 'Nome em uso' } })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Já existe uma marca/)
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    await app.close()
  })

  it('não confirma o cliente quando a marca vinculada desaparece antes do update', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT nome FROM clientes') && sql.includes('FOR UPDATE')) return { rows: [{ nome: 'Cliente anterior' }] }
      if (sql.includes('UPDATE clientes SET')) return clientPatchResult()
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'ativa' }] }
      if (sql.includes('SELECT 1 FROM marcas') && sql.includes('lower(nome)')) return { rows: [] }
      if (sql.includes('UPDATE marcas SET nome')) return { rows: [] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { nome: 'Cliente Renomeado' } })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'CLIENTE_MARCA_SYNC_CONFLICT' })
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    await app.close()
  })

  it('recusa nome já usado no tenant mesmo sem o índice único e desfaz o cliente', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT nome FROM clientes') && sql.includes('FOR UPDATE')) return { rows: [{ nome: 'Cliente anterior' }] }
      if (sql.includes('UPDATE clientes SET')) return clientPatchResult()
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'ativa' }] }
      if (sql.includes('SELECT 1 FROM marcas') && sql.includes('lower(nome)')) return { rows: [{ '?column?': 1 }] }
      if (sql.includes('UPDATE marcas SET nome')) throw new Error('não deveria atualizar a marca')
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { nome: 'NOME EM USO' } })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Já existe uma marca/)
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(calls.some((sql) => sql.includes('UPDATE marcas SET nome'))).toBe(false)
    await app.close()
  })

  it('não renomeia marca quando o PATCH não contém nome', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('UPDATE clientes SET')) return clientPatchResult()
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'ativa' }] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { email: 'novo@example.com' } })

    expect(response.statusCode).toBe(200)
    expect(calls.some((sql) => sql.includes('UPDATE marcas SET nome'))).toBe(false)
    await app.close()
  })

  it('não sincroniza a marca antiga quando o formulário reenvia o mesmo nome com outro campo', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT nome FROM clientes') && sql.includes('FOR UPDATE')) return { rows: [{ nome: 'Cliente atual' }] }
      if (sql.includes('UPDATE clientes SET')) return { rows: [{ id: clienteId, nome: 'Cliente atual', status: 'ativo' }] }
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) return { rows: [{ id: marcaId, status: 'ativa' }] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { nome: 'Cliente atual', email: 'novo@example.com' } })

    expect(response.statusCode).toBe(200)
    expect(calls.some((sql) => sql.includes('UPDATE marcas SET nome'))).toBe(false)
    await app.close()
  })

  it('retorna 404 e faz rollback se o cliente não existir ao travar o nome', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT nome FROM clientes') && sql.includes('FOR UPDATE')) return { rows: [] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)

    const response = await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { nome: 'Cliente ausente' } })

    expect(response.statusCode).toBe(404)
    expect(calls).toContain('ROLLBACK')
    expect(calls.some((sql) => sql.includes('UPDATE clientes SET'))).toBe(false)
    await app.close()
  })
})
