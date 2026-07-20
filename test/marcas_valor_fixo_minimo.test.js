import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { marcasRoutes } from '../src/routes/marcas.js'

function buildApp(queryMock) {
  const app = Fastify()
  const releaseMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('db', { query: queryMock })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return app
}

describe('marcas — valor_fixo_minimo (Onda 1 #3)', () => {
  it('GET /v1/marcas/:id exposes valor_fixo_minimo', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ id: 'marca-1', nome: 'Boca Rosa', tipo: 'afiliada', comissao_franquia_pct: 5, valor_fixo_minimo: '1500.00', apresentadoras: [] }],
    })
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/marcas/marca-1' })
    expect(response.statusCode).toBe(200)
    expect(response.json().valor_fixo_minimo).toBe('1500.00')

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain('m.valor_fixo_minimo')
  })

  it('PATCH /v1/marcas/:id persists valor_fixo_minimo', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{ id: 'marca-1', nome: 'Boca Rosa', tipo: 'afiliada', cliente_id: null, comissao_franquia_pct: 5, comissao_franqueadora_pct: 2, valor_fixo_minimo: '1500.00' }],
    })
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/marcas/marca-1',
      payload: { valor_fixo_minimo: 1500 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().valor_fixo_minimo).toBe('1500.00')

    // O UPDATE (2ª chamada, após o BEGIN) deve incluir a coluna no SET dinâmico.
    const updateSql = queryMock.mock.calls.map((c) => c[0]).find((q) => typeof q === 'string' && q.includes('UPDATE marcas SET'))
    expect(updateSql).toContain('valor_fixo_minimo =')
  })

  it('PATCH rejects negative valor_fixo_minimo (schema)', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/marcas/marca-1',
      payload: { valor_fixo_minimo: -10 },
    })

    expect(response.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('POST /v1/marcas — upsert de marca cliente não re-zera comissões (bug Posthaus)', () => {
  const clienteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  function upsertQueryMock(marcaRow) {
    return vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('UPDATE marcas SET')) return { rows: [marcaRow] }
      if (sql.includes('FROM clientes')) return { rows: [{ id: clienteId }] }
      // ensureClienteMarca → marca tipo='cliente' já existe e está ativa
      if (sql.includes('FROM marcas')) return { rows: [{ id: 'marca-1', status: 'ativa' }] }
      return { rows: [] }
    })
  }

  it('POST sem comissao_*_pct/valor_fixo_minimo preserva os valores existentes', async () => {
    const queryMock = upsertQueryMock({
      id: 'marca-1', tipo: 'cliente', cliente_id: clienteId, nome: 'Posthaus',
      comissao_franquia_pct: '5.00', comissao_franqueadora_pct: '2.00', valor_fixo_minimo: '1500.00',
    })
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/marcas',
      payload: { nome: 'Posthaus', tipo: 'cliente', cliente_id: clienteId },
    })

    expect(response.statusCode).toBe(201)
    // pct=5 configurado continua 5 — o upsert não regrava 0.
    expect(response.json().comissao_franquia_pct).toBe('5.00')

    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE marcas SET'))
    expect(updateCall[0]).toContain('comissao_franquia_pct = COALESCE($7, comissao_franquia_pct)')
    expect(updateCall[0]).toContain('comissao_franqueadora_pct = COALESCE($8, comissao_franqueadora_pct)')
    expect(updateCall[0]).toContain('valor_fixo_minimo = COALESCE($11, valor_fixo_minimo)')
    // Campos ausentes viram null → COALESCE mantém o valor do banco.
    expect(updateCall[1][6]).toBeNull()
    expect(updateCall[1][7]).toBeNull()
    expect(updateCall[1][10]).toBeNull()
    await app.close()
  })

  it('POST com comissao_franquia_pct explícito aplica o novo valor', async () => {
    const queryMock = upsertQueryMock({
      id: 'marca-1', tipo: 'cliente', cliente_id: clienteId, nome: 'Posthaus',
      comissao_franquia_pct: '7.00',
    })
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/marcas',
      payload: { nome: 'Posthaus', tipo: 'cliente', cliente_id: clienteId, comissao_franquia_pct: 7 },
    })

    expect(response.statusCode).toBe(201)
    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE marcas SET'))
    expect(updateCall[1][6]).toBe(7)
    await app.close()
  })
})
