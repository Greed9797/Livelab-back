import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

import { relatoriosRoutes } from '../src/routes/relatorios.js'

const TENANT = '00000000-0000-0000-0000-000000000001'
const USER_ID = '11111111-1111-1111-1111-111111111111'

function buildApp({
  papel = 'franqueado',
  userId = USER_ID,
  liveRows = [],
  cliRows = [{ id: 'cli-1', nome: 'Cliente X', nicho: 'moda', user_id: USER_ID }],
  boletoRows = [],
  metricsRows = [{ lives_realizadas: 0, gmv_total: 0, horas_realizadas: 0 }],
} = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: TENANT, papel, sub: userId }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: TENANT, papel, sub: userId }
    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
  })

  // Mock withTenant directly — relatorios usa app.withTenant(tenant_id, fn).
  app.decorate('withTenant', async (_tenantId, fn) => {
    const queryMock = vi.fn(async (sql) => {
      if (/FROM clientes\s+WHERE id/i.test(sql)) return { rows: cliRows }
      if (/FROM lives l/i.test(sql) && /encerrada/i.test(sql)) return { rows: liveRows }
      if (/FROM boletos/i.test(sql)) return { rows: boletoRows }
      if (/FROM lives/i.test(sql)) return { rows: liveRows }
      return { rows: metricsRows }
    })
    const release = vi.fn()
    return fn({ query: queryMock, release })
  })
  return app
}

describe('GET /v1/relatorios/financeiro/csv', () => {
  it('200 e content-type text/csv quando papel autorizado', async () => {
    const app = buildApp({
      papel: 'franqueado',
      liveRows: [
        {
          data: '2026-05-10',
          cliente: 'A',
          apresentador: 'B',
          cabine: 'C',
          gmv: 1000,
          comissao: 100,
          duracao_min: 60,
        },
      ],
    })
    await app.register(relatoriosRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/relatorios/financeiro/csv?periodo=2026-05',
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.headers['content-disposition']).toContain('financeiro-2026-05')
    await app.close()
  })

  it('403 quando papel sem READ_FINANCEIRO (apresentador)', async () => {
    const app = buildApp({ papel: 'apresentador' })
    await app.register(relatoriosRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/relatorios/financeiro/csv?periodo=2026-05',
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('400 quando periodo inválido', async () => {
    const app = buildApp({ papel: 'franqueado' })
    await app.register(relatoriosRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/relatorios/financeiro/csv?periodo=1999-13',
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('GET /v1/relatorios/boletos/csv', () => {
  it('200 csv com filter status=pendente', async () => {
    const app = buildApp({
      papel: 'franqueado',
      boletoRows: [
        { id: 'b1', cliente: 'X', valor: 99.9, vencimento: '2026-05-15', status: 'pendente', pago_em: null },
      ],
    })
    await app.register(relatoriosRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/relatorios/boletos/csv?periodo=2026-05&status=pendente',
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('boletos-pendente-2026-05')
    await app.close()
  })

  it('403 quando papel sem READ_BOLETOS (apresentador)', async () => {
    const app = buildApp({ papel: 'apresentador' })
    await app.register(relatoriosRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/relatorios/boletos/csv?periodo=2026-05',
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('GET /v1/relatorios/cliente/:clienteId/pdf', () => {
  it('200 application/pdf quando franqueado autorizado', async () => {
    const app = buildApp({ papel: 'franqueado' })
    await app.register(relatoriosRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/relatorios/cliente/cli-1/pdf?periodo=2026-05',
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    await app.close()
  })

  it('403 quando cliente_parceiro tenta acessar PDF de outro cliente', async () => {
    const app = buildApp({
      papel: 'cliente_parceiro',
      userId: 'other-user-id',
      cliRows: [{ id: 'cli-1', nome: 'X', nicho: null, user_id: 'owner-user' }],
    })
    await app.register(relatoriosRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/relatorios/cliente/cli-1/pdf?periodo=2026-05',
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('404 quando cliente não encontrado', async () => {
    const app = buildApp({ papel: 'franqueado', cliRows: [] })
    await app.register(relatoriosRoutes)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/relatorios/cliente/cli-x/pdf?periodo=2026-05',
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
