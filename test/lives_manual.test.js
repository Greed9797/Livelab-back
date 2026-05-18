import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { cabinesRoutes } from '../src/routes/cabines.js'
import { livesRoutes } from '../src/routes/lives.js'

const basePayload = {
  cabine_id:       '11111111-1111-4111-8111-111111111111',
  cliente_id:      '22222222-2222-4222-8222-222222222222',
  apresentador_id: '33333333-3333-4333-8333-333333333333',
  gestor_id:       '44444444-4444-4444-8444-444444444444',
  data:            '2026-05-01',
  hora_inicio:     '18:00',
  hora_fim:        '20:00',
  fat_gerado:      5000,
  qtd_pedidos:     42,
  resumo:          'Live de teste',
}

function buildApp({ papel = 'franqueado', queryRows = [], queryMock } = {}) {
  const app = Fastify()
  const _query = queryMock ?? vi.fn().mockResolvedValue({ rows: queryRows })
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: _query, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })
  app.decorate('db', { pool: { connect: vi.fn() } })

  return { app, _query, release }
}

async function registerLiveRoutes(app) {
  await app.register(livesRoutes)
}

describe('POST /v1/cabines', () => {
  it('creates cabine without tamanho and persists tamanho as null', async () => {
    let insertArgs = null
    const queryMock = vi.fn().mockImplementation((sql, args) => {
      insertArgs = args
      return {
        rows: [{
          id: 'cabine-1',
          numero: 1,
          nome: 'Cabine QA',
          tamanho: null,
          descricao: 'Operacional',
          status: 'disponivel',
        }],
      }
    })

    const { app } = buildApp({ queryMock })
    await app.register(cabinesRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/cabines',
      payload: { nome: 'Cabine QA', descricao: 'Operacional' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ nome: 'Cabine QA', tamanho: null, status: 'disponivel' })
    expect(insertArgs).toEqual(['tenant-1', 'Cabine QA', null, 'Operacional'])
    await app.close()
  })
})

describe('DELETE /v1/cabines/:id', () => {
  it('soft-deletes a cabine with history only after CABINE confirmation', async () => {
    const cabineId = '11111111-1111-4111-8111-111111111111'
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('SELECT id, status')) {
        return { rows: [{ id: cabineId, status: 'disponivel', live_atual_id: null, contrato_id: null }] }
      }
      if (sql.includes('FROM lives')) return { rows: [{ id: 'live-1' }], rowCount: 1 }
      if (sql.includes('FROM live_requests')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM agenda_eventos')) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE cabines')) return { rows: [{ id: cabineId }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })

    const { app } = buildApp({ queryMock })
    await app.register(cabinesRoutes)

    const blocked = await app.inject({ method: 'DELETE', url: `/v1/cabines/${cabineId}` })
    expect(blocked.statusCode).toBe(409)

    const confirmed = await app.inject({ method: 'DELETE', url: `/v1/cabines/${cabineId}?confirmacao=CABINE` })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json()).toMatchObject({ ok: true, soft_deleted: true })
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('ativo = false'))).toBe(true)
  })
})

describe('POST /v1/lives/manual', () => {
  it('creates a closed live and returns 201 with id', async () => {
    const liveId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                        // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'ativo' }] })     // cliente status
      .mockResolvedValueOnce({ rows: [{ comissao_pct: '10' }] }) // cabine/contrato
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-ap-1' }] }) // apresentadoras lookup ap1
      .mockResolvedValueOnce({ rows: [{ id: liveId }] })          // INSERT lives
      .mockResolvedValueOnce({ rows: [] })                        // marca lookup
      .mockResolvedValueOnce({ rows: [] })                        // COMMIT

    const { app } = buildApp({ queryMock })
    await registerLiveRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: basePayload,
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe(liveId)
  })

  it('calculates comissao = fat_gerado * (comissao_pct / 100)', async () => {
    let insertArgs = null
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'ativo' }] })
      .mockResolvedValueOnce({ rows: [{ comissao_pct: '20' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-ap-1' }] }) // apresentadoras lookup ap1
      .mockImplementationOnce((sql, args) => { insertArgs = args; return { rows: [{ id: 'id-1' }] } })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const { app } = buildApp({ queryMock })
    await registerLiveRoutes(app)

    await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: { ...basePayload, fat_gerado: 1000 },
    })

    // insertArgs[8] = comissao_calculada (after fat_gerado at [7])
    expect(insertArgs[8]).toBeCloseTo(200)
  })

  it('allows manual affiliate live using marca_id without cliente_id', async () => {
    const marcaId = '55555555-5555-4555-8555-555555555555'
    let insertArgs = null
    let vendaArgs = null
    const queryMock = vi.fn(async (sql, args = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM marcas') && sql.includes('WHERE id = $1')) {
        return { rows: [{ id: marcaId, cliente_id: null, tipo: 'afiliada' }] }
      }
      if (sql.includes('FROM cabines')) return { rows: [{ comissao_pct: '0' }] }
      if (sql.includes('SELECT user_id FROM apresentadoras')) return { rows: [{ user_id: null }] }
      if (sql.includes('SELECT id FROM lives')) return { rows: [] }
      if (sql.includes('INSERT INTO lives')) {
        insertArgs = args
        return { rows: [{ id: 'live-afiliada' }] }
      }
      if (sql.includes('INSERT INTO live_apresentadoras_v2')) return { rows: [] }
      if (sql.includes('FROM vendas_atribuidas')) return { rows: [] }
      if (sql.includes('SELECT comissao_live_pct')) {
        return { rows: [{ comissao_live_pct: '0', comissao_franquia_pct: '0', comissao_franqueadora_pct: '0' }] }
      }
      if (sql.includes('INSERT INTO vendas_atribuidas')) {
        vendaArgs = args
        return { rows: [{ id: 'venda-1' }] }
      }
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await registerLiveRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: {
        ...basePayload,
        tipo: 'afiliado',
        cliente_id: undefined,
        marca_id: marcaId,
      },
    })

    expect(res.statusCode).toBe(201)
    expect(insertArgs[2]).toBeNull()
    expect(vendaArgs).toContain(marcaId)
  })

  it('inserts apresentador2 into live_apresentadores junction', async () => {
    const junctionCalls = []
    const ap2UserId = '66666666-6666-4666-8666-666666666666'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'ativo' }] })
      .mockResolvedValueOnce({ rows: [{ comissao_pct: '0' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-ap-1' }] })      // ap1 lookup
      .mockResolvedValueOnce({ rows: [{ user_id: ap2UserId }] })         // ap2 lookup
      .mockResolvedValueOnce({ rows: [{ id: 'live-2' }] })
      .mockResolvedValueOnce({ rows: [] })                               // live_apresentadoras_v2 ap1
      .mockImplementationOnce((sql, args) => { junctionCalls.push({ sql, args }); return { rows: [] } })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const { app } = buildApp({ queryMock })
    await registerLiveRoutes(app)

    const ap2 = '55555555-5555-4555-8555-555555555555'
    await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: { ...basePayload, apresentador2_id: ap2 },
    })

    expect(junctionCalls).toHaveLength(1)
    expect(junctionCalls[0].args[2]).toBe(ap2UserId)
  })

  it('returns 400 when hora_fim <= hora_inicio', async () => {
    const { app } = buildApp()
    await registerLiveRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: { ...basePayload, hora_inicio: '20:00', hora_fim: '18:00' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/hora_fim/)
  })

  it('returns 400 when apresentador2_id equals apresentador_id', async () => {
    const { app } = buildApp()
    await registerLiveRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: { ...basePayload, apresentador2_id: basePayload.apresentador_id },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/apresentadora 2/)
  })

  it('returns 403 when called by apresentador role', async () => {
    const { app } = buildApp({ papel: 'apresentador' })
    await registerLiveRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: basePayload,
    })

    expect(res.statusCode).toBe(403)
  })
})

describe('PATCH /v1/lives/:id (edição manual)', () => {
  it('updates fat_gerado and recalculates comissao', async () => {
    const liveId = 'live-edit-1'
    const updateArgs = []
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({             // SELECT live FOR UPDATE
        rows: [{
          id: liveId,
          cabine_id:    basePayload.cabine_id,
          fat_gerado:   '1000',
          iniciado_em:  '2026-05-01T18:00:00Z',
          encerrado_em: '2026-05-01T20:00:00Z',
        }]
      })
      .mockResolvedValueOnce({ rows: [{ comissao_pct: '10' }] }) // busca comissao
      .mockImplementationOnce((sql, args) => { updateArgs.push(args); return { rows: [] } }) // UPDATE lives
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const { app } = buildApp({ queryMock })
    await registerLiveRoutes(app)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}`,
      payload: { fat_gerado: 2000 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    // comissao = 2000 * 0.10 = 200
    const comissaoIdx = updateArgs[0].indexOf(200)
    expect(comissaoIdx).toBeGreaterThan(-1)
  })

  it('returns 404 for non-existent or non-encerrada live', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT live (not found)
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    const { app } = buildApp({ queryMock })
    await registerLiveRoutes(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/lives/nonexistent-id',
      payload: { fat_gerado: 100 },
    })

    expect(res.statusCode).toBe(404)
  })
})
