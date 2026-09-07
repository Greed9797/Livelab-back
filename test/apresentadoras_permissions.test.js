import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { apresentadorasRoutes } from '../src/routes/apresentadoras.js'

function buildApp({ papel = 'franqueado', queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
    }
  })
  app.decorate('withTenant', async (_tenantId, fn) => {
    try { return await fn({ query }) } finally { release() }
  })

  return { app, query, release }
}

describe('apresentadoras permissions', () => {
  it('blocks legacy direct presenter creation outside settings users flow', async () => {
    const { app } = buildApp()
    await app.register(apresentadorasRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/apresentadoras',
      payload: { nome: 'Jhemily', fixo: 0, comissao_pct: 0 },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json()).toMatchObject({ flow: 'usuarios.convidar' })

    await app.close()
  })

  it('allows franqueado to edit presenter profiles', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [{
        id: 'ap-1',
        nome: 'Edja',
        ativo: true,
      }],
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/apresentadoras/ap-1',
      payload: { nome: 'Edja Live' },
    })

    expect(response.statusCode).toBe(200)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras'))).toBe(true)

    await app.close()
  })

  it('allows franqueado to delete presenter profiles as soft delete', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ id: 'ap-1' }] })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/apresentadoras/ap-1',
    })

    expect(response.statusCode).toBe(204)
    expect(query.mock.calls.some(([sql]) => /UPDATE apresentadoras SET ativo\s*=\s*false/.test(sql))).toBe(true)

    await app.close()
  })

  it('resolves a presenter user id when listing commission tiers', async () => {
    // Mock por SQL (não posicional): o seed das faixas default agora consulta
    // tenant_comissao_faixas_default antes de inserir.
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('FROM apresentadoras WHERE id =')) return { rows: [] }
      if (sql.includes('apresentadoras') && sql.includes('user_id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('ORDER BY ativo DESC')) return { rows: [{ id: 'faixa-1', apresentadora_id: 'ap-1', gmv_inicio: 0, gmv_fim: null, comissao_pct: 2, ativo: true }] }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/apresentadoras/user-2/faixas-comissao',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([
      expect.objectContaining({ id: 'faixa-1', apresentadora_id: 'ap-1' }),
    ])
    expect(query.mock.calls.at(-1)?.[1]).toEqual(['tenant-1', 'ap-1'])
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO apresentadoras'))).toBe(false)

    await app.close()
  })

  it('resolves a presenter user id when updating a commission tier', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'ap-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'faixa-1', apresentadora_id: 'ap-1', gmv_inicio: 0, gmv_fim: null, comissao_pct: 3, ativo: true }] })
      .mockResolvedValue({ rows: [] })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/apresentadoras/user-2/faixas-comissao/faixa-1',
      payload: { comissao_pct: 3 },
    })

    expect(response.statusCode).toBe(200)
    const updateCall = query.mock.calls.find(([sql]) => sql.includes('UPDATE apresentadora_comissao_faixas'))
    expect(updateCall?.[1]?.slice(0, 3)).toEqual(['ap-1', 'faixa-1', 'tenant-1'])

    await app.close()
  })

  it('GET /v1/apresentadoras devolve origem_dados de cada apresentadora', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'ap-1', nome: 'Ana', origem_dados: 'bot' }] })
    const { app } = buildApp({ queryMock: query })
    await app.register(apresentadorasRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/apresentadoras' })

    expect(res.statusCode).toBe(200)
    expect(query.mock.calls[0][0]).toContain('origem_dados')
    expect(res.json()[0].origem_dados).toBe('bot')
  })

  it('synchronizes presenter name and email to its same-tenant inactive presenter user atomically', async () => {
    const calls = []
    const queryMock = vi.fn(async (sql, params = []) => {
      calls.push([sql, params])
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('SELECT id FROM apresentadoras WHERE id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('SELECT id, user_id, ativo, arquivada FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2', ativo: true, arquivada: false }] }
      if (sql.includes('FROM users') && sql.includes('papel')) return { rows: [{ id: 'user-2', papel: 'apresentadora', ativo: false, email: 'old@test.com' }] }
      if (sql.includes('LOWER(email)')) return { rows: [] }
      if (sql.includes('UPDATE apresentadoras SET')) return { rows: [{ id: 'ap-1', nome: 'Nova Ana', email: 'ana@new.test', fixo: 2700 }] }
      if (sql.includes('UPDATE users SET')) return { rows: [] }
      if (sql.includes('FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2', ativo: true, arquivada: false }] }
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)
    const response = await app.inject({ method: 'PATCH', url: '/v1/apresentadoras/ap-1', payload: { nome: 'Nova Ana', email: 'ana@new.test' } })
    expect(response.statusCode).toBe(200)
    const userSync = calls.find(([sql]) => sql.includes('UPDATE users SET'))
    expect(userSync?.[1]).toEqual(['Nova Ana', 'ana@new.test', 'user-2', 'tenant-1'])
    expect(userSync?.[0]).toContain('token_version=token_version+1')
    expect(calls.some(([sql]) => sql.includes('DELETE FROM refresh_tokens'))).toBe(true)
    expect(calls.at(-1)[0]).toBe('COMMIT')
    await app.close()
  })

  it('does not write a standalone profile if it becomes linked while being edited', async () => {
    let profileLookups = 0
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT id FROM apresentadoras WHERE id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('SELECT id, user_id FROM apresentadoras') && !sql.includes('FOR UPDATE')) return { rows: [{ id: 'ap-1', user_id: null }] }
      if (sql.includes('SELECT id, user_id FROM apresentadoras') && sql.includes('FOR UPDATE')) {
        profileLookups += 1
        return { rows: [{ id: 'ap-1', user_id: 'user-now-linked' }] }
      }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)
    const response = await app.inject({ method: 'PATCH', url: '/v1/apresentadoras/ap-1', payload: { nome: 'Ana' } })
    expect(response.statusCode).toBe(409)
    expect(profileLookups).toBe(1)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras SET'))).toBe(false)
    await app.close()
  })

  it('does not revoke an invalid linked account when deleting a presenter profile', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT id FROM apresentadoras WHERE id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('SELECT user_id FROM apresentadoras') && !sql.includes('FOR UPDATE')) return { rows: [{ user_id: 'user-not-presenter' }] }
      if (sql.includes('SELECT id, papel FROM users')) return { rows: [{ id: 'user-not-presenter', papel: 'operacional' }] }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)
    const response = await app.inject({ method: 'DELETE', url: '/v1/apresentadoras/ap-1' })
    expect(response.statusCode).toBe(409)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras SET ativo=false'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM refresh_tokens'))).toBe(false)
    await app.close()
  })

  it('does not reactivate an inactive linked user from the presenter endpoint', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT id FROM apresentadoras WHERE id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('SELECT id, user_id, ativo, arquivada FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2', ativo: false, arquivada: false }] }
      if (sql.includes('FROM users') && sql.includes('papel')) return { rows: [{ id: 'user-2', papel: 'apresentadora', ativo: false, email: 'old@test.com' }] }
      if (sql.includes('FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2', ativo: false, arquivada: false }] }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)
    const response = await app.inject({ method: 'PATCH', url: '/v1/apresentadoras/ap-1', payload: { ativo: true } })
    expect(response.statusCode).toBe(409)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras SET'))).toBe(false)
    await app.close()
  })

  it('does not let an operational role reactivate an inactive linked profile', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT id FROM apresentadoras WHERE id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('SELECT id, user_id FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2' }] }
      if (sql.includes('FROM users') && sql.includes('papel')) return { rows: [{ id: 'user-2', papel: 'apresentadora', ativo: true, email: 'old@test.com' }] }
      if (sql.includes('SELECT id, user_id, ativo, arquivada FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2', ativo: false, arquivada: false }] }
      return { rows: [] }
    })
    const { app, query } = buildApp({ papel: 'operacional', queryMock })
    await app.register(apresentadorasRoutes)
    const response = await app.inject({ method: 'PATCH', url: '/v1/apresentadoras/ap-1', payload: { ativo: true } })
    expect(response.statusCode).toBe(403)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras SET'))).toBe(false)
    await app.close()
  })

  it('does not permit archiving a linked profile through the presenter endpoint', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT id FROM apresentadoras WHERE id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('SELECT id, user_id FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2' }] }
      if (sql.includes('FROM users') && sql.includes('papel')) return { rows: [{ id: 'user-2', papel: 'apresentadora', ativo: true, email: 'old@test.com' }] }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)
    const response = await app.inject({ method: 'PATCH', url: '/v1/apresentadoras/ap-1', payload: { arquivada: true } })
    expect(response.statusCode).toBe(409)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras SET'))).toBe(false)
    await app.close()
  })

  it('does not let operational roles change an inactive linked login email', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT id FROM apresentadoras WHERE id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('SELECT id, user_id FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2' }] }
      if (sql.includes('FROM users') && sql.includes('papel')) return { rows: [{ id: 'user-2', papel: 'apresentadora', ativo: false, email: 'old@test.com' }] }
      if (sql.includes('SELECT id, user_id, ativo, arquivada FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2', ativo: true, arquivada: false }] }
      if (sql.includes('LOWER(email)')) return { rows: [] }
      if (sql.includes('FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2', ativo: true, arquivada: false }] }
      return { rows: [] }
    })
    const { app, query } = buildApp({ papel: 'operacional', queryMock })
    await app.register(apresentadorasRoutes)
    const response = await app.inject({ method: 'PATCH', url: '/v1/apresentadoras/ap-1', payload: { email: 'new@test.com' } })
    expect(response.statusCode).toBe(403)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras SET') || sql.includes('UPDATE users SET'))).toBe(false)
    await app.close()
  })

  it('returns 409 without writes when a linked login email collides in the tenant', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT id FROM apresentadoras WHERE id')) return { rows: [{ id: 'ap-1' }] }
      if (sql.includes('SELECT id, user_id FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2' }] }
      if (sql.includes('FROM users') && sql.includes('papel')) return { rows: [{ id: 'user-2', papel: 'apresentadora', ativo: true, email: 'old@test.com' }] }
      if (sql.includes('SELECT id, user_id, ativo, arquivada FROM apresentadoras')) return { rows: [{ id: 'ap-1', user_id: 'user-2', ativo: true, arquivada: false }] }
      if (sql.includes('LOWER(email)')) return { rows: [{ id: 'other-user' }] }
      return { rows: [] }
    })
    const { app, query } = buildApp({ queryMock })
    await app.register(apresentadorasRoutes)
    const response = await app.inject({ method: 'PATCH', url: '/v1/apresentadoras/ap-1', payload: { email: 'taken@test.com' } })
    expect(response.statusCode).toBe(409)
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras SET') || sql.includes('UPDATE users SET'))).toBe(false)
    await app.close()
  })
})
