import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { describe, expect, it, vi } from 'vitest'

import { PAPEL_POR_ESCOPO } from '../src/routes/api_keys.js'
import { authPlugin, chaveAlcancaRota, hashDaChave } from '../src/plugins/auth.js'
import { cadastrosRoutes } from '../src/routes/cadastros.js'
import { apiKeysRoutes } from '../src/routes/api_keys.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const keyId = '33333333-3333-4333-8333-333333333333'
const chave = 'llk_chave-cadastros-de-teste-com-tamanho-suficiente'

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48)

function buildApp({ papel = 'automacao_cadastros', viaApiKey = { id: 'key-1', nome: 'contratos' } } = {}) {
  const app = Fastify()
  const query = vi.fn(async () => ({ rows: [] }))
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: null, papel }
    request.viaApiKey = viaApiKey
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query, release: vi.fn() }))
  return { app, query }
}

async function buildRealAuthApp(linhaDaChave) {
  const app = Fastify()
  const query = vi.fn(async (sql) => {
    if (sql.includes('FROM api_keys')) return { rows: linhaDaChave ? [linhaDaChave] : [] }
    if (sql.includes('UPDATE api_keys')) return { rows: [] }
    throw new Error(`SQL inesperado: ${sql}`)
  })
  await app.register(fp(async (instancia) => instancia.decorate('db', { query }), { name: 'db' }))
  await app.register(authPlugin)
  const handler = async () => ({ ok: true })
  app.get('/v1/cadastros', { preHandler: [app.authenticate] }, handler)
  app.get('/v1/cadastros/:id', { preHandler: [app.authenticate] }, handler)
  app.patch('/v1/cadastros/:id', { preHandler: [app.authenticate] }, handler)
  app.post('/v1/cadastros', { preHandler: [app.authenticate] }, handler)
  app.get('/v1/lives', { preHandler: [app.authenticate] }, handler)
  return { app, query }
}

describe('escopo de automação cadastral', () => {
  it('cria o papel próprio e só libera os três métodos cadastrados', () => {
    expect(PAPEL_POR_ESCOPO.cadastros).toBe('automacao_cadastros')
    expect(chaveAlcancaRota('GET', '/v1/cadastros', 'automacao_cadastros')).toBe(true)
    expect(chaveAlcancaRota('GET', `/v1/cadastros/${marcaId}`, 'automacao_cadastros')).toBe(true)
    expect(chaveAlcancaRota('PATCH', `/v1/cadastros/${marcaId}`, 'automacao_cadastros')).toBe(true)
    expect(chaveAlcancaRota('POST', '/v1/cadastros', 'automacao_cadastros')).toBe(false)
    expect(chaveAlcancaRota('PATCH', `/v1/cadastros/${marcaId}/promover-cliente`, 'automacao_cadastros')).toBe(false)
    expect(chaveAlcancaRota('GET', '/v1/marcas', 'automacao_cadastros')).toBe(false)
  })

  it('recusa campos não cadastrais e referência ausente antes de qualquer SQL', async () => {
    const { app, query } = buildApp()
    await app.register(cadastrosRoutes)

    const semReferencia = await app.inject({ method: 'PATCH', url: `/v1/cadastros/${marcaId}`, payload: { nome: 'Novo nome' } })
    expect(semReferencia.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()

    const financeiro = await app.inject({ method: 'PATCH', url: `/v1/cadastros/${marcaId}`, payload: { referencia_documento: 'Contrato 01', valor_fixo_minimo: 10 } })
    expect(financeiro.statusCode).toBe(403)
    expect(query).not.toHaveBeenCalled()

    const referenciaLonga = await app.inject({ method: 'PATCH', url: `/v1/cadastros/${marcaId}`, payload: { referencia_documento: 'a'.repeat(501), nome: 'Novo nome' } })
    expect(referenciaLonga.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('autenticação real da chave cadastral', () => {
  const chaveViva = {
    id: keyId, tenant_id: tenantId, nome: 'agente de contratos', criado_por: null,
    papel: 'automacao_cadastros', revogada_em: null, expira_em: null,
  }

  it('aceita apenas os métodos cadastrados e põe no-store inclusive na negativa', async () => {
    const { app, query } = await buildRealAuthApp(chaveViva)
    for (const [method, url, expected] of [
      ['GET', '/v1/cadastros', 200],
      ['GET', `/v1/cadastros/${marcaId}`, 200],
      ['PATCH', `/v1/cadastros/${marcaId}`, 200],
      ['POST', '/v1/cadastros', 403],
      ['GET', '/v1/lives', 403],
    ]) {
      const response = await app.inject({ method, url, headers: { 'x-api-key': chave } })
      expect(response.statusCode).toBe(expected)
      expect(response.headers['cache-control']).toBe('private, no-store')
    }
    expect(query.mock.calls.some(([sql]) => sql.includes('token_version'))).toBe(false)
    await app.close()
  })

  it('recusa chave inválida, expirada ou revogada com 401 privado', async () => {
    for (const linha of [
      null,
      { ...chaveViva, revogada_em: '2026-10-01T00:00:00.000Z' },
      { ...chaveViva, expira_em: '2020-01-01T00:00:00.000Z' },
    ]) {
      const { app } = await buildRealAuthApp(linha)
      const response = await app.inject({ method: 'GET', url: '/v1/cadastros', headers: { 'x-api-key': chave } })
      expect(response.statusCode).toBe(401)
      expect(response.headers['cache-control']).toBe('private, no-store')
      await app.close()
    }
    expect(hashDaChave(chave)).toHaveLength(64)
  })
})

describe('criação da chave cadastral', () => {
  it('persiste o novo papel e somente o hash da chave', async () => {
    const app = Fastify()
    const query = vi.fn(async () => ({ rows: [{ id: keyId, nome: 'agente contratos', prefixo: 'llk_prefixo', papel: 'automacao_cadastros', criado_em: '2026-10-21', expira_em: null }] }))
    app.decorate('authenticate', async (request) => { request.user = { tenant_id: tenantId, sub: keyId, papel: 'gerente' } })
    app.decorate('requirePapel', () => async () => {})
    app.decorate('dbTenant', async () => ({ query, release: vi.fn() }))
    await app.register(apiKeysRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/api-keys', payload: { nome: 'agente contratos', escopo: 'cadastros' } })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ escopo: 'cadastros', papel: 'automacao_cadastros' })
    const [, values] = query.mock.calls[0]
    expect(values[3]).toHaveLength(64)
    expect(values[3]).not.toBe(response.json().chave)
    expect(values[6]).toBe('automacao_cadastros')
    await app.close()
  })
})
