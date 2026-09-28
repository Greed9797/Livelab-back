import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { authPlugin } from '../src/plugins/auth.js'
import { apresentadorasRoutes } from '../src/routes/apresentadoras.js'
import { usuariosRoutes } from '../src/routes/usuarios.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const keyId = '66666666-6666-4666-8666-666666666666'
const userId = '33333333-3333-4333-8333-333333333333'
const apresentadoraId = '44444444-4444-4444-8444-444444444444'
const CHAVE = 'llk_chave-de-teste-com-tamanho-suficiente'

const DUPLICATA = {
  error: 'E-mail já cadastrado e ativo neste tenant.',
  code: 'EMAIL_ALREADY_ACTIVE',
}

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48)
})

function chaveViva() {
  return {
    id: keyId,
    tenant_id: tenantId,
    papel: 'automacao',
    nome: 'grok bot',
    criado_por: null,
    revogada_em: null,
    expira_em: null,
  }
}

function presenterPayload(extra = {}) {
  return {
    nome: 'Jhemily',
    email: 'jhemily@example.com',
    papel: 'apresentadora',
    fixo: 2700,
    comissao_pct: 1.5,
    senha_temporaria: 'senha123',
    ...extra,
  }
}

/**
 * @param {'cria' | 'duplicata' | 'vincula' | 'perfil'} cenario
 */
async function buildApp(cenario) {
  const app = Fastify()
  const query = vi.fn(async (sql, values = []) => {
    if (sql.includes('FROM api_keys')) return { rows: [chaveViva()] }
    if (sql.includes('UPDATE api_keys')) return { rows: [] }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
    if (sql.includes('token_version')) {
      return { rows: [{ token_version: 1, ativo: true, papel: 'franqueado', tenant_id: tenantId }] }
    }
    if (sql.includes('SELECT id FROM users')) {
      return { rows: cenario === 'duplicata' ? [{ id: userId }] : [] }
    }
    if (sql.includes('INSERT INTO users')) {
      return {
        rows: [{
          id: userId,
          nome: values[1],
          email: values[2],
          papel: values[4],
          ativo: true,
          criado_em: '2026-09-28T00:00:00.000Z',
        }],
      }
    }
    if (sql.includes('INSERT INTO apresentadoras')) return { rows: [{ id: apresentadoraId }], rowCount: 1 }
    if (sql.includes('UPDATE apresentadoras') && sql.includes('SET user_id')) {
      return { rows: [{ id: apresentadoraId }], rowCount: 1 }
    }
    if (sql.includes('apresentadora_comissao_faixas') && sql.includes('SELECT')) {
      return { rows: [{ id: 'tier' }] }
    }
    if (cenario === 'perfil') {
      if (sql.includes('UPDATE apresentadoras')) {
        return { rows: [{ id: apresentadoraId, nome: values[2], origem_dados: 'manual' }] }
      }
      if (sql.includes('FOR UPDATE')) return { rows: [{ id: apresentadoraId, user_id: null }] }
      if (sql.includes('SELECT id, user_id')) return { rows: [{ id: apresentadoraId, user_id: null }] }
      if (sql.includes('SELECT id FROM apresentadoras')) return { rows: [{ id: apresentadoraId }] }
    }
    return { rows: [] }
  })

  await app.register(fp(async (instancia) => {
    instancia.decorate('db', { query })
  }, { name: 'db' }))
  await app.register(authPlugin)
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query }))
  await app.register(usuariosRoutes)
  if (cenario === 'perfil') await app.register(apresentadorasRoutes)
  return { app, query }
}

describe('chave cadastra a apresentadora que o gestor cadastra', () => {
  it('cria usuária e perfil no tenant da chave, com origem bot', async () => {
    const { app, query } = await buildApp('cria')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usuarios/convidar',
      headers: { 'x-api-key': CHAVE },
      payload: presenterPayload({ origem_dados: 'manual' }),
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      id: userId,
      email: 'jhemily@example.com',
      papel: 'apresentadora',
      apresentadora_id: apresentadoraId,
      pode_apresentar_live: true,
    })
    const insertUser = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'))
    expect(insertUser[1][0]).toBe(tenantId)
    const insertPerfil = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO apresentadoras'))
    expect(insertPerfil[0]).toContain('origem_dados')
    expect(insertPerfil[1][0]).toBe(tenantId)
    expect(insertPerfil[1][1]).toBe(userId)
    expect(insertPerfil[1][7]).toBe('bot')
    await app.close()
  })

  it('recusa e-mail duplicado com o mesmo 409 do gestor', async () => {
    const { app, query } = await buildApp('duplicata')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usuarios/convidar',
      headers: { 'x-api-key': CHAVE },
      payload: presenterPayload(),
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual(DUPLICATA)
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO users'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO apresentadoras'))).toBe(false)
    await app.close()
  })

  it('não reescreve a origem ao vincular um perfil que já existe', async () => {
    const { app, query } = await buildApp('vincula')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usuarios/convidar',
      headers: { 'x-api-key': CHAVE },
      payload: presenterPayload({ apresentadora_id: apresentadoraId }),
    })

    expect(res.statusCode).toBe(201)
    const link = query.mock.calls.find(([sql]) => sql.includes('UPDATE apresentadoras'))
    expect(link[0]).not.toContain('origem_dados')
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO apresentadoras'))).toBe(false)
    await app.close()
  })

  it('não reescreve a origem num PATCH posterior do perfil', async () => {
    const { app, query } = await buildApp('perfil')
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/apresentadoras/${apresentadoraId}`,
      headers: { 'x-api-key': CHAVE },
      payload: { nome: 'Nova', origem_dados: 'bot' },
    })

    expect(res.statusCode).toBe(200)
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE apresentadoras'))
    const gravacao = update[0].split('WHERE')[0]
    expect(gravacao).toContain('nome =')
    expect(gravacao).not.toMatch(/origem_dados\s*=/)
    expect(update[1]).not.toContain('bot')
    await app.close()
  })

  it('não cadastra financeiro nem outro papel de usuário', async () => {
    const { app, query } = await buildApp('cria')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usuarios/convidar',
      headers: { 'x-api-key': CHAVE },
      payload: presenterPayload({ papel: 'financeiro' }),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('Esta chave só cadastra apresentadora.')
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO users'))).toBe(false)
    await app.close()
  })

  it('mantém 403 em DELETE e no resto da administração de usuários', async () => {
    const id = '77777777-7777-4777-8777-777777777777'
    const { app, query } = await buildApp('cria')
    const bloqueadas = [
      ['DELETE', `/v1/usuarios/${id}`],
      ['PATCH', `/v1/usuarios/${id}`],
      ['GET', '/v1/usuarios'],
      ['POST', `/v1/usuarios/${id}/reset-senha`],
    ]
    for (const [method, url] of bloqueadas) {
      const res = await app.inject({
        method,
        url,
        headers: { 'x-api-key': CHAVE },
        payload: method === 'GET' || method === 'DELETE' ? undefined : { nome: 'Nao' },
      })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().error).toBe('Esta chave não tem acesso a esta rota')
    }
    expect(query.mock.calls.some(([sql]) => /DELETE FROM users/i.test(sql))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE users'))).toBe(false)
    await app.close()
  })
})
