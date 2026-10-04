import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { marcasRoutes } from '../src/routes/marcas.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const clienteA = '33333333-3333-4333-8333-333333333333'
const clienteB = '44444444-4444-4444-8444-444444444444'

function buildApp(atual) {
  const app = Fastify()
  const calls = []
  const query = vi.fn(async (sql) => {
    calls.push(String(sql))
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
    if (sql.includes('SELECT tipo, cliente_id FROM marcas')) return { rows: [atual] }
    if (sql.includes('FROM clientes')) return { rows: [{ id: clienteA }] }
    if (sql.includes('lower(nome)')) return { rows: [] }
    if (/^\s*UPDATE marcas SET/.test(sql)) return { rows: [{ id: marcaId, ...atual }] }
    return { rows: [] }
  })
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'u', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  return { app, calls }
}

describe('PATCH /v1/marcas/:id — tipo cliente só muda pelo cadastro', () => {
  it.each([
    ['sair de cliente', { tipo: 'cliente', cliente_id: clienteA }, { tipo: 'afiliada' }],
    ['entrar em cliente', { tipo: 'afiliada', cliente_id: null }, { tipo: 'cliente', cliente_id: clienteA }],
    ['trocar a ficha', { tipo: 'cliente', cliente_id: clienteA }, { cliente_id: clienteB }],
  ])('%s → 409 USE_CADASTRO_ENDPOINT sem UPDATE', async (_n, atual, payload) => {
    const { app, calls } = buildApp(atual)
    await app.register(marcasRoutes)
    const res = await app.inject({ method: 'PATCH', url: `/v1/marcas/${marcaId}`, payload })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('USE_CADASTRO_ENDPOINT')
    expect(calls.some((sql) => /^\s*UPDATE marcas SET/.test(sql))).toBe(false)
    expect(calls).toContain('ROLLBACK')
  })

  it.each([
    ['form reenviando o mesmo tipo/ficha', { tipo: 'cliente', cliente_id: clienteA }, { tipo: 'cliente', cliente_id: clienteA, nome: 'Rosa' }],
    ['afiliada → parceira', { tipo: 'afiliada', cliente_id: null }, { tipo: 'parceira' }],
    ['só nome', { tipo: 'cliente', cliente_id: clienteA }, { nome: 'Rosa' }],
  ])('%s continua 200', async (_n, atual, payload) => {
    const { app } = buildApp(atual)
    await app.register(marcasRoutes)
    const res = await app.inject({ method: 'PATCH', url: `/v1/marcas/${marcaId}`, payload })
    expect(res.statusCode).toBe(200)
  })

  it('listagem usa o status com cliente apagado e expõe gera_receita', async () => {
    const { app, calls } = buildApp({})
    await app.register(marcasRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/marcas' })
    expect(res.statusCode).toBe(200)
    const sql = calls.find((s) => s.includes('FROM marcas m'))
    expect(sql).toContain("c.deleted_at IS NOT NULL THEN 'arquivada'")
    expect(sql).toContain("m.tipo = 'cliente' AND COALESCE(m.sistema, false) = false) AS gera_receita")
  })
})
