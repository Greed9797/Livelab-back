import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { describe, expect, it, vi, beforeAll } from 'vitest'

import { authPlugin, chaveAlcancaRota, hashDaChave, origemDados } from '../src/plugins/auth.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const keyId = '66666666-6666-4666-8666-666666666666'
const CHAVE = 'llk_chave-de-teste-com-tamanho-suficiente'

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48)
})

/**
 * @param linhaDaChave o que o SELECT em api_keys devolve; [] simula chave inexistente
 */
async function buildApp(linhaDaChave, rota = { metodo: 'GET', caminho: '/v1/lives' }) {
  const app = Fastify()
  const query = vi.fn(async (sql) => {
    if (sql.includes('FROM api_keys')) return { rows: linhaDaChave ? [linhaDaChave] : [] }
    if (sql.includes('UPDATE api_keys')) return { rows: [] }
    if (sql.includes('token_version')) return { rows: [] }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  // authPlugin declara dependência do plugin 'db'; aqui entra um dublê com o
  // mesmo nome, só com o `query`.
  await app.register(fp(async (instancia) => { instancia.decorate('db', { query }) }, { name: 'db' }))
  await app.register(authPlugin)

  const handler = async (request) => ({
    tenant_id: request.user.tenant_id,
    papel: request.user.papel,
    sub: request.user.sub,
  })
  app.route({
    method: rota.metodo,
    url: rota.caminho,
    preHandler: [app.authenticate],
    handler,
  })
  return { app, query }
}

const chaveViva = {
  id: keyId,
  tenant_id: tenantId,
  papel: 'automacao',
  nome: 'grok bot',
  revogada_em: null,
  expira_em: null,
}

describe('allowlist da chave de API', () => {
  it('libera só o que está na lista, e nunca DELETE', () => {
    expect(chaveAlcancaRota('POST', '/v1/analytics/imports/ingest')).toBe(true)
    expect(chaveAlcancaRota('GET', '/v1/lives?status=encerrada')).toBe(true)
    expect(chaveAlcancaRota('PATCH', '/v1/marcas/66666666-6666-4666-8666-666666666666')).toBe(true)
    // sub-rota de escrita e id que não é uuid ficam de fora, mesmo com prefixo na lista
    expect(chaveAlcancaRota('PATCH', '/v1/lives/66666666-6666-4666-8666-666666666666/encerrar')).toBe(false)
    expect(chaveAlcancaRota('POST', '/v1/lives/manual')).toBe(true)
    expect(chaveAlcancaRota('POST', '/v1/lives/manual/66666666-6666-4666-8666-666666666666')).toBe(false)
    expect(chaveAlcancaRota('POST', '/v1/lives/manual/x')).toBe(false)
    expect(chaveAlcancaRota('PATCH', '/v1/marcas/abc')).toBe(false)

    // O que não pode: o dinheiro, as pessoas e as chaves do gateway.
    expect(chaveAlcancaRota('GET', '/v1/financeiro/dashboard')).toBe(false)
    expect(chaveAlcancaRota('POST', '/v1/usuarios')).toBe(false)
    expect(chaveAlcancaRota('GET', '/v1/configuracoes')).toBe(false)
    expect(chaveAlcancaRota('DELETE', '/v1/lives/abc')).toBe(false)
    expect(chaveAlcancaRota('POST', '/v1/api-keys')).toBe(false)
  })
})

describe('origemDados', () => {
  it("é 'bot' quando a request veio por chave, ignorando o body", () => {
    expect(origemDados({ viaApiKey: { id: 'k' } })).toBe('bot')
    expect(origemDados({ viaApiKey: { id: 'k' } }, 'manual')).toBe('bot')
    expect(origemDados({ viaApiKey: { id: 'k' } }, 'api')).toBe('bot')
  })
  it("sem chave vale o body, e 'manual' na falta dele", () => {
    expect(origemDados({})).toBe('manual')
    expect(origemDados({}, 'api')).toBe('api')
    expect(origemDados({}, undefined)).toBe('manual')
  })
})

describe('autenticação por chave de API', () => {
  it('autentica e prende a request ao tenant da chave', async () => {
    const { app, query } = await buildApp(chaveViva)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/lives',
      headers: { 'x-api-key': CHAVE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      tenant_id: tenantId,
      papel: 'automacao',
      // criado_por NULL no mock: sub tem de ser usuário real ou NULL (colunas com FK para users)
      sub: null,
    })
    // A busca é pelo hash: a chave em texto nunca vai ao banco.
    const [sql, params] = query.mock.calls.find(([s]) => s.includes('FROM api_keys'))
    expect(params[0]).toBe(hashDaChave(CHAVE))
    expect(params[0]).not.toContain(CHAVE)
    expect(sql).toContain('key_hash = $1')
  })

  it('recusa chave inexistente, revogada e expirada com a mesma resposta', async () => {
    const casos = [
      null,
      { ...chaveViva, revogada_em: '2026-08-01T00:00:00.000Z' },
      { ...chaveViva, expira_em: '2020-01-01T00:00:00.000Z' },
    ]
    for (const caso of casos) {
      const { app } = await buildApp(caso)
      const res = await app.inject({
        method: 'GET',
        url: '/v1/lives',
        headers: { 'x-api-key': CHAVE },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json().error).toBe('Chave de API inválida')
    }
  })

  it('barra rota fora da allowlist mesmo com chave válida', async () => {
    const { app } = await buildApp(chaveViva, { metodo: 'GET', caminho: '/v1/financeiro/resumo' })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/financeiro/resumo',
      headers: { 'x-api-key': CHAVE },
    })
    expect(res.statusCode).toBe(403)
  })

  it('sem chave nenhuma segue o caminho do JWT e recusa quem não tem token', async () => {
    const { app, query } = await buildApp(chaveViva)
    const res = await app.inject({ method: 'GET', url: '/v1/lives' })
    expect(res.statusCode).toBe(401)
    // Nem chegou a consultar api_keys: não havia header de chave.
    expect(query.mock.calls.filter(([s]) => s.includes('FROM api_keys'))).toHaveLength(0)
  })
})
