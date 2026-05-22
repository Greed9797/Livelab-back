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
      payload: { nome: 'Jhemily', fixo: 0, comissao_pct: 0, meta_diaria_gmv: 0 },
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
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE apresentadoras SET ativo = false'))).toBe(true)

    await app.close()
  })

  it('resolves a presenter user id when listing commission tiers', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-2', nome: 'Jhemily', email: 'jhemily@example.com', papel: 'apresentador' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ap-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'default-faixa' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'faixa-1', apresentadora_id: 'ap-1', gmv_inicio: 0, gmv_fim: null, comissao_pct: 2, ativo: true }] })
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
})
