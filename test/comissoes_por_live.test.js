import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { comissoesRoutes } from '../src/routes/comissoes.js'

const { calcularMock } = vi.hoisted(() => ({
  calcularMock: vi.fn().mockResolvedValue([]),
}))
vi.mock('../src/services/commission-engine.js', () => ({
  calcularComissoesDaLive: (...args) => calcularMock(...args),
}))

function buildApp(queryMock, { papel = 'franqueado' } = {}) {
  const app = Fastify()
  const releaseMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })
  app.decorate('db', { query: queryMock })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return app
}

describe('GET /v1/lives/:id/comissoes', () => {
  it('returns comissoes trio for a live', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'va-1',
          gmv: '1000',
          comissao_apresentadora: '10',
          comissao_franquia: '100',
          comissao_franqueadora: '20',
          pct_apresentadora: '1.00',
          status_aprovacao: 'pendente_aprovacao',
          marca_id: 'marca-uuid-1',
          marca_nome: 'Marca Teste',
          apresentadora_id: 'apres-uuid-1',
          apresentadora_nome: 'Ana Silva',
        },
      ],
    })

    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const liveId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const response = await app.inject({
      method: 'GET',
      url: `/v1/lives/${liveId}/comissoes`,
    })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(payload.live_id).toBe(liveId)
    expect(payload.comissoes).toHaveLength(1)
    expect(payload.comissoes[0]).toMatchObject({
      gmv: 1000,
      comissao_apresentadora: 10,
      comissao_franquia: 100,
      comissao_franqueadora: 20,
      pct_apresentadora: 1,
      marca_nome: 'Marca Teste',
      apresentadora_nome: 'Ana Silva',
      status_aprovacao: 'pendente_aprovacao',
    })

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain("va.origem = 'live'")
    expect(sql).toContain('va.origem_id = $2::uuid')
    expect(sql).toContain('pct_apresentadora')
  })

  it('returns 200 with empty/pendente when no comissoes exist yet (não é erro)', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/lives/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/comissoes',
    })

    // Comissão ainda não calculada não deve quebrar o "ver detalhes": 200 + lista vazia.
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ comissoes: [], pendente: true })
  })
})

describe('GET /v1/comissoes/por-live', () => {
  it('returns vendas atribuídas list for given month', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        {
          live_id: 'live-uuid-1',
          data: '2026-05-10',
          gmv: '2000',
          comissao_apresentadora: '20',
          comissao_franquia: '200',
          comissao_franqueadora: '40',
          pct_aplicado: '1.00',
          status_aprovacao: 'pendente_aprovacao',
          marca_nome: 'Marca Alpha',
          apresentadora_nome: 'Bia Costa',
        },
      ],
    })

    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/comissoes/por-live?mes=2026-05',
    })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(Array.isArray(payload)).toBe(true)
    expect(payload).toHaveLength(1)
    expect(payload[0]).toMatchObject({
      live_id: 'live-uuid-1',
      gmv: 2000,
      comissao_apresentadora: 20,
      pct_aplicado: 1,
      marca_nome: 'Marca Alpha',
      apresentadora_nome: 'Bia Costa',
    })

    const sql = queryMock.mock.calls[0][0]
    expect(sql).toContain("va.origem = 'live'")
    expect(sql).toContain("to_char(va.data::date, 'YYYY-MM') = $2")
    expect(sql).toContain('ORDER BY va.data DESC')
  })

  it('returns 400 when mes param is missing', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/comissoes/por-live',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: expect.stringContaining('mes') })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('returns 400 when mes param has wrong format', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/comissoes/por-live?mes=05-2026',
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('POST /v1/comissoes/reprocessar', () => {
  it('sem lives candidatas devolve os três contadores zerados', async () => {
    calcularMock.mockClear()
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/comissoes/reprocessar' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ orfas: 0, divergentes_gmv: 0, ignoradas: 0 })
    const sql = String(queryMock.mock.calls[0][0])
    expect(sql).toContain('NOT EXISTS')
    expect(sql).toContain('IS DISTINCT FROM')
    expect(sql).toContain('COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)')
    expect(sql).toContain('> 0')
    expect(sql).not.toContain('comissao_apresentadora')
    expect(calcularMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('conta órfã, GMV divergente e comissão zero com GMV igual em ignoradas', async () => {
    calcularMock.mockReset()
    calcularMock.mockImplementation(async (_db, { liveId }) => {
      if (liveId === 'live-orfa') return [{ id: 'va-nova', comissao_apresentadora: 4 }]
      if (liveId === 'live-div') return [{ id: 'va-div', gmv: 300, comissao_apresentadora: 6 }]
      throw new Error(`não deveria recalcular ${liveId}`)
    })
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        { id: 'live-zero', gmv: '100', pedidos: '1', classe: 'ignorada' },
        { id: 'live-orfa', gmv: '200', pedidos: '2', classe: 'orfa' },
        { id: 'live-div', gmv: '300', pedidos: '3', classe: 'divergente' },
        { id: 'live-nula', gmv: '0', pedidos: '0', classe: 'ignorada' },
      ],
    })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/comissoes/reprocessar' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ orfas: 1, divergentes_gmv: 1, ignoradas: 2 })
    const ids = calcularMock.mock.calls.map((call) => call[1].liveId)
    expect(ids).toEqual(['live-orfa', 'live-div'])
    expect(calcularMock.mock.calls[0][1].gmv).toBe(200)
    await app.close()
  })
})

describe('PATCH /v1/comissoes/:id/aprovar', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  function linha(overrides) {
    return {
      id,
      status_aprovacao: 'pendente_aprovacao',
      comissao_apresentadora: '10',
      diagnostico_operacional: 'pronta_para_aprovar',
      ...overrides,
    }
  }

  function queryFor(row) {
    const updates = []
    const queryMock = vi.fn(async (sql, params) => {
      if (String(sql).includes('UPDATE')) {
        updates.push({ sql: String(sql), params })
        return {
          rows: [{
            id,
            status_aprovacao: 'aprovada',
            status_motivo: params[0],
            aprovado_em: '2026-06-01T00:00:00.000Z',
            comissao_apresentadora: row.comissao_apresentadora,
          }],
        }
      }
      return { rows: [row] }
    })
    return { queryMock, updates }
  }

  async function aprovar(row, payload, papel = 'franqueado') {
    const { queryMock, updates } = queryFor(row)
    const app = buildApp(queryMock, { papel })
    await app.register(comissoesRoutes)
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/comissoes/${id}/aprovar`,
      payload,
    })
    return { response, updates, app, queryMock }
  }

  it('409 sem marca ou sem apresentadora e não muda o status', async () => {
    for (const diagnostico of ['sem_marca', 'sem_apresentadora']) {
      const { response, updates, app, queryMock } = await aprovar(linha({ diagnostico_operacional: diagnostico }))
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ diagnostico_operacional: diagnostico })
      expect(updates).toHaveLength(0)
      expect(String(queryMock.mock.calls[0][0])).toContain(`THEN '${diagnostico}'`)
      await app.close()
    }
  })

  it('409 para comissão zero sem flag e 200 com flag mantendo o valor 0', async () => {
    const zerada = linha({ diagnostico_operacional: 'comissao_zero', comissao_apresentadora: '0' })
    const bloqueada = await aprovar(zerada, { motivo: 'ok aprovar' })
    expect(bloqueada.response.statusCode).toBe(409)
    expect(bloqueada.response.json()).toMatchObject({ diagnostico_operacional: 'comissao_zero' })
    expect(bloqueada.updates).toHaveLength(0)
    await bloqueada.app.close()

    const confirmada = await aprovar(zerada, { confirmar_zero: true, motivo: '  zero combinado' })
    expect(confirmada.response.statusCode).toBe(200)
    expect(confirmada.response.json().comissao_apresentadora).toBe('0')
    expect(confirmada.updates[0].sql).not.toMatch(/comissao_apresentadora\s*=/)
    expect(confirmada.updates[0].sql).not.toMatch(/comissao_franquia\s*=/)
    expect(confirmada.updates[0].sql).not.toMatch(/comissao_franqueadora\s*=/)
    expect(confirmada.updates[0].params[0]).toBe('zero combinado')
    expect(confirmada.app.audit.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'comissao.aprovar',
      metadata: expect.objectContaining({ confirmar_zero: true }),
    }))
    await confirmada.app.close()
  })

  it('409 para reprovada sem reabrir e reabre gravando o motivo novo', async () => {
    const reprovada = linha({ status_aprovacao: 'reprovada', diagnostico_operacional: 'pronta_para_aprovar' })
    const bloqueada = await aprovar(reprovada, { motivo: 'quero reabrir' })
    expect(bloqueada.response.statusCode).toBe(409)
    expect(bloqueada.updates).toHaveLength(0)
    await bloqueada.app.close()

    const reaberta = await aprovar(reprovada, { reabrir: true, motivo: 'revisto' })
    expect(reaberta.response.statusCode).toBe(200)
    expect(reaberta.response.json().status_aprovacao).toBe('aprovada')
    expect(reaberta.updates[0].params[0]).toBe('revisto')
    expect(reaberta.app.audit.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'comissao.reabrir',
    }))
    await reaberta.app.close()
  })

  it('mantém 409 quando a linha já está aprovada', async () => {
    const { response, updates, app } = await aprovar(linha({ status_aprovacao: 'aprovada' }), {})
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Comissão já aprovada')
    expect(updates).toHaveLength(0)
    await app.close()
  })
})
