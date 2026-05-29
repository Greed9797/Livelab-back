import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

import { apresentadoraDisponibilidadeRoutes } from '../src/routes/apresentadora_disponibilidade.js'

const TENANT = '00000000-0000-0000-0000-000000000001'
const APR_ID = '11111111-1111-4111-8111-111111111111'

function buildApp({ papel = 'franqueado', queryImpl } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (req) => {
    req.user = { tenant_id: TENANT, papel, sub: 'u1' }
  })
  app.decorate('requirePapel', (papeis) => async (req, reply) => {
    if (!req.user) req.user = { tenant_id: TENANT, papel, sub: 'u1' }
    if (!papeis.includes(req.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  const queryMock = queryImpl ?? vi.fn().mockResolvedValue({ rows: [] })
  app.decorate('withTenant', async (_t, fn) => fn({ query: queryMock, release: () => {} }))
  return { app, queryMock }
}

// helper que constrói queryImpl baseado em respostas pra cada step
function makeQueryImpl({ apresentadora = { id: APR_ID, user_id: 'apr-user' }, dow = 1, slots = [{}], bloqueios = [], lives = [] } = {}) {
  return vi.fn(async (sql) => {
    if (/FROM apresentadoras WHERE id/i.test(sql)) {
      return { rows: apresentadora ? [apresentadora] : [] }
    }
    if (/EXTRACT\(DOW/i.test(sql)) return { rows: [{ dow }] }
    if (/FROM apresentadora_disponibilidade/i.test(sql)) return { rows: slots }
    if (/FROM apresentadora_bloqueios/i.test(sql)) return { rows: bloqueios }
    if (/FROM lives l/i.test(sql)) return { rows: lives }
    return { rows: [] }
  })
}

describe('GET /v1/disponibilidade/check', () => {
  it('200 com disponivel=true quando sem conflitos', async () => {
    const queryMock = makeQueryImpl({ slots: [{ ok: 1 }] })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(apresentadoraDisponibilidadeRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disponibilidade/check?apresentadora_id=${APR_ID}&data=2026-05-15&hora_inicio=10:00&hora_fim=11:00`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ disponivel: true, conflito: null })
    await app.close()
  })

  it('disponivel=false tipo fora_da_grade quando não há slot na grade', async () => {
    const queryMock = makeQueryImpl({ slots: [] })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(apresentadoraDisponibilidadeRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disponibilidade/check?apresentadora_id=${APR_ID}&data=2026-05-15&hora_inicio=10:00&hora_fim=11:00`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.disponivel).toBe(false)
    expect(body.conflito.tipo).toBe('fora_da_grade')
    await app.close()
  })

  it('disponivel=false tipo bloqueio_pontual quando há bloqueio sobreposto', async () => {
    const queryMock = makeQueryImpl({
      slots: [{ ok: 1 }],
      bloqueios: [{ id: 'blq-1', motivo: 'Férias', data_inicio: 'x', data_fim: 'y' }],
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(apresentadoraDisponibilidadeRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disponibilidade/check?apresentadora_id=${APR_ID}&data=2026-05-15&hora_inicio=10:00&hora_fim=11:00`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.disponivel).toBe(false)
    expect(body.conflito.tipo).toBe('bloqueio_pontual')
    expect(body.conflito.detalhe).toBe('Férias')
    await app.close()
  })

  it('disponivel=false tipo live_agendada quando já está em live conflitante', async () => {
    const queryMock = makeQueryImpl({
      slots: [{ ok: 1 }],
      bloqueios: [],
      lives: [{ id: 'live-1', status: 'em_andamento', iniciado_em: 'x', encerrado_em: null }],
    })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(apresentadoraDisponibilidadeRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disponibilidade/check?apresentadora_id=${APR_ID}&data=2026-05-15&hora_inicio=10:00&hora_fim=11:00`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.disponivel).toBe(false)
    expect(body.conflito.tipo).toBe('live_agendada')
    expect(body.conflito.live_id).toBe('live-1')
    await app.close()
  })

  it('400 quando hora_fim <= hora_inicio', async () => {
    const { app } = buildApp({ queryImpl: makeQueryImpl({ slots: [{ ok: 1 }] }) })
    await app.register(apresentadoraDisponibilidadeRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disponibilidade/check?apresentadora_id=${APR_ID}&data=2026-05-15&hora_inicio=11:00&hora_fim=10:00`,
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('404 quando apresentadora não existe', async () => {
    const queryMock = makeQueryImpl({ apresentadora: null })
    const { app } = buildApp({ queryImpl: queryMock })
    await app.register(apresentadoraDisponibilidadeRoutes)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disponibilidade/check?apresentadora_id=${APR_ID}&data=2026-05-15&hora_inicio=10:00&hora_fim=11:00`,
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
