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
      if (sql.includes('DELETE FROM receita_titulos')) return { rows: [] }
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

describe('cadastro unificado — merge, exclusão e marca_id', () => {
  const vencedor = '44444444-4444-4444-8444-444444444444'
  const duplicado = '55555555-5555-4555-8555-555555555555'

  function mergeQuery({ espelhos }) {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      if (sql.includes('FROM clientes') && sql.includes('FOR UPDATE')) {
        return { rows: [
          { id: vencedor, nome: 'A', email: 'a@x.com', cnpj: null },
          { id: duplicado, nome: 'A2', email: 'A@x.com ', cnpj: null },
        ] }
      }
      if (sql.includes('GROUP BY cliente_id')) return { rows: espelhos }
      if (/^\s*UPDATE (lives|marcas|contratos)/.test(sql)) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE clientes')) return { rows: [{ id: duplicado }] }
      if (sql.includes('INSERT INTO cliente_merge_auditoria')) return { rows: [] }
      throw new Error(`query inesperada: ${sql}`)
    })
    return { query, calls }
  }

  it('merge com marca espelho nos dois clientes → 409 MERGE_MARCA_ESPELHO sem mover nada', async () => {
    const { query, calls } = mergeQuery({ espelhos: [{ cliente_id: vencedor, n: 1 }, { cliente_id: duplicado, n: 1 }] })
    const app = buildApp(query)
    await app.register(clientesRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/clientes/merge-restrito', payload: { vencedor_id: vencedor, duplicado_id: duplicado } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('MERGE_MARCA_ESPELHO')
    expect(calls.some((sql) => /^\s*UPDATE/.test(sql))).toBe(false)
    expect(calls).toContain('ROLLBACK')
    await app.close()
  })

  it('merge com só uma marca espelho segue o fluxo antigo', async () => {
    const { query } = mergeQuery({ espelhos: [{ cliente_id: duplicado, n: 1 }] })
    const app = buildApp(query)
    await app.register(clientesRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/clientes/merge-restrito', payload: { vencedor_id: vencedor, duplicado_id: duplicado } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, criterio: 'email' })
    await app.close()
  })

  it('violação do índice de marca espelho vira 409 (corrida), não 500', async () => {
    const { query } = mergeQuery({ espelhos: [] })
    const base = query.getMockImplementation()
    query.mockImplementation(async (sql, params) => {
      if (/^\s*UPDATE marcas/.test(sql)) throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uniq_marca_cliente_por_tenant' })
      return base(sql, params)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/clientes/merge-restrito', payload: { vencedor_id: vencedor, duplicado_id: duplicado } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('MERGE_MARCA_ESPELHO')
    await app.close()
  })

  it('DELETE arquiva a marca espelho do cliente na mesma transação', async () => {
    const calls = []
    const query = vi.fn(async (sql, params) => {
      calls.push([String(sql), params])
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      if (sql.includes('UPDATE clientes SET deleted_at')) return { rows: [{ id: clienteId }] }
      if (sql.includes("UPDATE marcas SET status = 'arquivada'")) return { rows: [] }
      if (sql.includes('DELETE FROM receita_titulos')) return { rows: [] }
      throw new Error(`query inesperada: ${sql}`)
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)
    const res = await app.inject({ method: 'DELETE', url: `/v1/clientes/${clienteId}` })
    expect(res.statusCode).toBe(200)
    const arquivar = calls.find(([sql]) => sql.includes("UPDATE marcas SET status = 'arquivada'"))
    expect(arquivar[0]).toContain("tipo = 'cliente'")
    expect(arquivar[1]).toEqual([clienteId, tenantId])
    expect(calls.map(([sql]) => sql)).toEqual(['BEGIN', expect.stringContaining('deleted_at'), expect.stringContaining('arquivada'), expect.stringContaining('DELETE FROM receita_titulos'), 'COMMIT'])
    await app.close()
  })

  it('DELETE de cliente inexistente → 404 sem tocar marca', async () => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(String(sql))
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)
    const res = await app.inject({ method: 'DELETE', url: `/v1/clientes/${clienteId}` })
    expect(res.statusCode).toBe(404)
    expect(calls.some((sql) => sql.includes('UPDATE marcas'))).toBe(false)
    await app.close()
  })

  it('GET /v1/clientes/:id acrescenta marca_id (marca tipo cliente principal)', async () => {
    const query = vi.fn(async (sql) => {
      expect(sql).toContain("m.tipo = 'cliente'")
      expect(sql).toContain('AS marca_id')
      return { rows: [{ id: clienteId, nome: 'Cliente', marca_id: marcaId }] }
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)
    const res = await app.inject({ method: 'GET', url: `/v1/clientes/${clienteId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: clienteId, nome: 'Cliente', marca_id: marcaId })
    await app.close()
  })
})
