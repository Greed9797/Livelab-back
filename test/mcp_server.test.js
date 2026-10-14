import { createHash, generateKeyPairSync } from 'node:crypto'
import bcrypt from 'bcrypt'
import Fastify from 'fastify'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mcpRoutes } from '../src/mcp/server.js'
import { artifactHash } from '../src/mcp/oauth-adapter.js'
import { authPlugin } from '../src/plugins/auth.js'
import { authRoutes } from '../src/routes/auth.js'
import { configuracoesRoutes } from '../src/routes/configuracoes.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { remuneracaoApresentadorasRoutes } from '../src/routes/remuneracao_apresentadoras.js'

const uid = '11111111-1111-4111-8111-111111111111', tenant = '22222222-2222-4222-8222-222222222222'
beforeAll(() => vi.stubEnv('JWT_SECRET', 'synthetic-mcp-jwt-secret-at-least-32-characters'))
afterAll(() => vi.unstubAllEnvs())
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { enabled: true, origin: 'https://livelab.test', issuer: 'https://livelab.test/oauth', resource: 'https://livelab.test/mcp',
  clientId: 'chatgpt-test', redirectUri: 'https://chatgpt.com/connector/oauth/test',
  cookieKeys: ['test-cookie-secret-with-at-least-32-characters'], storageKey: Buffer.alloc(32, 7).toString('base64'),
  jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }] } }

async function setup() {
  const artifacts = new Map(), bindings = new Map()
  const user = { id: uid, tenant_id: tenant, ativo: true, papel: 'franqueado', token_version: 1,
    email: 'test@livelab.test', senha_hash: await bcrypt.hash('test-password', 4) }
  const app = Fastify()
  app.decorate('db', { query: async (sql, p = []) => {
    if (sql.includes('FROM users')) return { rows: user.ativo && (p[0] === uid || p[0] === user.email) ? [{ ...user }] : [] }
    if (sql.startsWith('UPDATE users') && sql.includes('senha_hash')) { user.senha_hash = p[0]; user.token_version++; return { rows: [] } }
    if (sql.startsWith('UPDATE refresh_tokens')) return { rows: [] }
    if (sql.startsWith('INSERT INTO mcp_oauth_artifacts')) {
      const old = artifacts.get(`${p[0]}:${p[1]}`)
      artifacts.set(`${p[0]}:${p[1]}`, { model: p[0], id_hash: p[1], payload: p[2], expires_at: Date.now() + p[3] * 1000,
        grant_hash: p[4], uid_hash: p[5], user_code_hash: p[6], consumed_at: old?.consumed_at })
      return { rows: [] }
    }
    if (sql.startsWith('SELECT payload')) {
      const column = sql.match(/AND (\w+) = \$2/)[1]
      return { rows: [...artifacts.values()].filter(r => r.model === p[0] && r[column] === p[1] && r.expires_at > Date.now()) }
    }
    if (sql.startsWith('UPDATE mcp_oauth_artifacts')) {
      const r = artifacts.get(`${p[0]}:${p[1]}`)
      if (!r || r.consumed_at) return { rows: [], rowCount: 0 }
      r.consumed_at = new Date(); return { rows: [{ id_hash: p[1] }], rowCount: 1 }
    }
    if (sql.startsWith('DELETE FROM mcp_oauth_artifacts')) {
      for (const [key, row] of artifacts) if (p.length === 2 ? row.model === p[0] && row.id_hash === p[1] : row.grant_hash === p[0] || row.model === 'Grant' && row.id_hash === p[0]) artifacts.delete(key)
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO mcp_oauth_bindings')) { bindings.set(p[0], { user_id: p[1], tenant_id: p[2], token_version: p[3] }); return { rows: [] } }
    if (sql.startsWith('SELECT tenant_id')) return { rows: bindings.has(p[0]) ? [bindings.get(p[0])] : [] }
    if (sql.startsWith('DELETE FROM mcp_oauth_bindings')) { bindings.delete(p[0]); return { rows: [] } }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 50)}`)
  } })
  app.decorate('withTenant', async (t, fn) => {
    expect(t).toBe(tenant)
    return fn({ query: async (sql, p) => sql.startsWith('UPDATE users') || sql.startsWith('UPDATE refresh_tokens') ? app.db.query(sql, p) : { rows: [] } })
  })
  await authPlugin(app)
  await app.register(authRoutes)
  await app.register(configuracoesRoutes)
  await app.register(financeiroRoutes)
  await app.register(remuneracaoApresentadorasRoutes)
  let provider
  await app.register(mcpRoutes, { config, onProvider: p => { provider = p } })
  await app.ready()
  const cookies = new Map()
  const req = async (url, method = 'GET', payload, extraHeaders = {}) => {
    const result = await app.inject({ method, url: new URL(url, config.origin).pathname + new URL(url, config.origin).search,
      headers: { host: 'livelab.test', 'x-forwarded-proto': 'https', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extraHeaders }, payload })
    const values = result.headers['set-cookie'] || []
    for (const cookie of Array.isArray(values) ? values : [values]) { const [pair] = cookie.split(';'); const [key, ...value] = pair.split('='); cookies.set(key, value.join('=')) }
    return result
  }
  return { app, provider, user, req, artifacts }
}

async function connect(fixture, scope = 'openid offline_access livelab:analytics:read livelab:finance:read') {
  const verifier = 'a'.repeat(64)
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: 'code', scope, resource: config.resource, state: 'test-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
  let res = await fixture.req(`/oauth/auth?${params}`)
  expect(res.statusCode, res.body).toBe(303)
  res = await fixture.req(res.headers.location)
  expect(res.statusCode, res.body).toBe(200)
  const token = res.body.match(/name="csrf" value="([^"]+)"/)[1]
  const action = res.body.match(/action="([^"]+)"/)[1]
  res = await fixture.req(action, 'POST', new URLSearchParams({ csrf: token, email: 'test@livelab.test', senha: 'test-password', acao: 'autorizar' }).toString(),
    { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' })
  expect(res.statusCode, res.body).toBe(303)
  for (let i = 0; i < 5 && res.headers.location && !res.headers.location.startsWith(config.redirectUri); i++) {
    res = await fixture.req(res.headers.location)
    expect(res.statusCode, res.body).toBe(303)
  }
  const location = new URL(res.headers.location, config.origin)
  expect(location.origin + location.pathname).toBe(config.redirectUri)
  expect(location.searchParams.get('state')).toBe('test-state')
  const code = location.searchParams.get('code')
  expect(code, res.headers.location).toBeTruthy()
  return { code, verifier }
}

async function exchange(f, input) {
  return f.req('/oauth/token', 'POST', new URLSearchParams({ client_id: config.clientId, resource: config.resource, ...input }).toString(),
    { 'content-type': 'application/x-www-form-urlencoded' })
}
const mcp = (f, bearer, body) => f.req('/mcp', 'POST', body, { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' })

describe('MCP remoto e OAuth integrado', () => {
  it('permanece ausente quando desligado', async () => {
    const app = Fastify(); await app.register(mcpRoutes, { config: { enabled: false } })
    expect((await app.inject('/mcp')).statusCode).toBe(404); await app.close()
  })
  it('publica discovery e exige OAuth no endpoint MCP', async () => {
    const f = await setup()
    const discovery = await f.req('/oauth/.well-known/openid-configuration')
    expect(discovery.statusCode, discovery.body).toBe(200)
    expect(discovery.json()).toMatchObject({ issuer: config.issuer, code_challenge_methods_supported: ['S256'] })
    expect((await f.req('/.well-known/oauth-protected-resource/mcp')).json().resource).toBe(config.resource)
    const res = await f.req('/mcp', 'POST', {})
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toContain('resource_metadata')
    await f.app.close()
  })
  it('executa login, consentimento, PKCE, refresh, ferramentas e revogação', async () => {
    const f = await setup(), grant = await connect(f)
    let res = await exchange(f, { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, redirect_uri: config.redirectUri })
    expect(res.statusCode, res.body).toBe(200)
    const tokens = res.json()
    expect(tokens.refresh_token).toBeTruthy()
    res = await mcp(f, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    expect(res.statusCode, res.body).toBe(200)
    res = await mcp(f, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(res.json().result.tools).toHaveLength(17)
    res = await mcp(f, tokens.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'consultar_resumo', arguments: { inicio: '2026-10-01', fim: '2026-10-02' } } })
    expect(res.json().result.structuredContent.dados.gmv_total).toBe(0)
    res = await exchange(f, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    expect(res.statusCode, res.body).toBe(200)
    const refreshed = res.json()
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
    res = await f.req('/oauth/token/revocation', 'POST', new URLSearchParams({ client_id: config.clientId, token: refreshed.refresh_token, token_type_hint: 'refresh_token' }).toString(), { 'content-type': 'application/x-www-form-urlencoded' })
    expect(res.statusCode, res.body).toBe(200)
    expect((await mcp(f, refreshed.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })).statusCode).toBe(401)
    await f.app.close()
  })
  it('nega PKCE incorreto e callback não cadastrado', async () => {
    const f = await setup(), grant = await connect(f)
    const res = await exchange(f, { grant_type: 'authorization_code', code: grant.code, code_verifier: 'b'.repeat(64), redirect_uri: config.redirectUri })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_grant')
    const bad = await f.req('/oauth/auth?' + new URLSearchParams({ client_id: config.clientId, redirect_uri: 'https://attacker.test', response_type: 'code', scope: 'openid' }))
    expect(bad.statusCode).toBe(400)
    expect(bad.headers.location).toBeUndefined()
    await f.app.close()
  })
  it('consulta financeiro e fechamento pelo SDK e nega comparação sem escopo financeiro', async () => {
    const f = await setup(), grant = await connect(f)
    const tokens = (await exchange(f, { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, redirect_uri: config.redirectUri })).json()
    for (const [name, args] of [
      ['consultar_resultado_operacional', { inicio: '2026-10', fim: '2026-10' }],
      ['consultar_fechamento_apresentadores', { mes: '2026-10' }],
      ['consultar_memoria_financeira', { mes: '2026-10', tipo: 'operacional' }],
    ]) {
      const response = await mcp(f, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      expect(response.json().result.isError, response.body).not.toBe(true)
      expect(response.json().result.structuredContent.avisos.join(' ')).toContain('saldo bancário não')
    }
    await f.app.close()
    const analytics = await setup(), aGrant = await connect(analytics, 'openid livelab:analytics:read')
    const aTokens = (await exchange(analytics, { grant_type: 'authorization_code', code: aGrant.code, code_verifier: aGrant.verifier, redirect_uri: config.redirectUri })).json()
    const denied = await mcp(analytics, aTokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'comparar_periodos', arguments: { atual: { inicio: '2026-10-01', fim: '2026-10-31' }, anterior: { inicio: '2026-09-01', fim: '2026-09-30' }, financeiro: true },
    } })
    expect(denied.json().result.isError).toBe(true)
    expect(denied.json().result.content[0].text).toContain('finance:read')
    await analytics.app.close()
  })
  it('não reutiliza código de autorização e bloqueia usuário inativo', async () => {
    const f = await setup(), grant = await connect(f)
    const input = { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, redirect_uri: config.redirectUri }
    const initial = await exchange(f, input)
    expect(initial.statusCode).toBe(200)
    expect((await exchange(f, input)).statusCode).toBe(400)
    f.user.ativo = false
    expect((await mcp(f, initial.json().access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).statusCode).toBe(401)
    await f.app.close()
  })
  it('nega token expirado e recurso OAuth diferente', async () => {
    const f = await setup(), grant = await connect(f)
    const tokens = (await exchange(f, { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, redirect_uri: config.redirectUri })).json()
    for (const artifact of f.artifacts.values()) if (artifact.model === 'AccessToken') artifact.expires_at = Date.now() - 1
    expect((await mcp(f, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).statusCode).toBe(401)
    const response = await exchange(f, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: 'https://attacker.test/mcp' })
    expect(response.statusCode).toBe(400)
    await f.app.close()
  })
  it('revoga MCP também na troca de senha pelas configurações', async () => {
    const f = await setup(), grant = await connect(f)
    const tokens = (await exchange(f, { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, redirect_uri: config.redirectUri })).json()
    const jwt = f.app.jwt.sign({ sub: uid, tenant_id: tenant, papel: f.user.papel, token_version: f.user.token_version })
    const change = await f.req('/v1/configuracoes', 'PATCH', { nova_senha: 'ConfigChanged123456' }, { authorization: `Bearer ${jwt}` })
    expect(change.statusCode, change.body).toBe(200)
    expect((await mcp(f, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).statusCode).toBe(401)
    expect((await exchange(f, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).statusCode).toBe(400)
    await f.app.close()
  })
  it('oculta ferramentas financeiras sem escopo e revoga após mudança de senha', async () => {
    const f = await setup(), grant = await connect(f, 'openid offline_access livelab:analytics:read')
    const tokens = (await exchange(f, { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, redirect_uri: config.redirectUri })).json()
    const list = await mcp(f, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(list.json().result.tools).toHaveLength(11)
    const jwt = f.app.jwt.sign({ sub: uid, tenant_id: tenant, papel: f.user.papel, token_version: f.user.token_version })
    const change = await f.req('/v1/auth/senha', 'PATCH', { senha_atual: 'test-password', nova_senha: 'Changed123456' }, { authorization: `Bearer ${jwt}` })
    expect(change.statusCode, change.body).toBe(200)
    expect((await mcp(f, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).statusCode).toBe(401)
    expect((await exchange(f, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).statusCode).toBe(400)
    await f.app.close()
  })
})
