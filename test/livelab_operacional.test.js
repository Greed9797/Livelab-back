import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'
import { comissoesRoutes } from '../src/routes/comissoes.js'
import { marcasRoutes } from '../src/routes/marcas.js'
import { vendasAtribuidasRoutes } from '../src/routes/vendas_atribuidas.js'
import { videosRoutes } from '../src/routes/videos.js'

function buildApp({ papel = 'franqueado', queryMock } = {}) {
  const app = Fastify()
  const _query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })
  const release = vi.fn()
  const tenantIds = []

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: _query, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    tenantIds.push(tenantId)
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })

  return { app, _query, release, tenantIds }
}

describe('LIVELAB operational routes', () => {
  it('GET /v1/marcas uses withTenant and explicit tenant filter', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce({
      rows: [{ id: 'marca-1', nome: 'Marca A', ativo: true }],
    })
    const { app, tenantIds } = buildApp({ queryMock })
    await app.register(marcasRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/marcas' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{ id: 'marca-1', nome: 'Marca A', ativo: true }])
    expect(tenantIds).toEqual(['tenant-1'])
    expect(queryMock.mock.calls[0][0]).toContain('WHERE m.tenant_id = $1::uuid')
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-1'])
    await app.close()
  })

  it('POST /v1/agenda inserts tenant-scoped agenda events', async () => {
    const marcaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: marcaId }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'agenda-1', marca_id: marcaId, status: 'planejado' }],
      })
    const { app } = buildApp({ queryMock })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        data_inicio: '2026-05-20T18:00:00Z',
        data_fim: '2026-05-20T19:00:00Z',
      },
    })

    expect(res.statusCode).toBe(201)
    const insertCall = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO agenda_eventos'))
    expect(insertCall).toBeTruthy()
    expect(insertCall[1][0]).toBe('tenant-1')
    await app.close()
  })

  it('POST /v1/videos with GMV upserts vendas_atribuidas origem=video', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM marcas')) return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', comissao_franquia_pct: '10', comissao_franqueadora_pct: '2.5' }] }
      if (sql.includes('FROM apresentadoras')) return { rows: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] }
      if (sql.includes('FROM apresentadora_marcas')) return { rows: [{ comissao_video_pct: '12.5' }] }
      if (sql.includes('FROM vendas_atribuidas')) return { rows: [] }
      if (sql.includes('INSERT INTO vendas_atribuidas')) {
        return { rows: [{ id: 'venda-1', origem: 'video', gmv: '1000.00', comissao_apresentadora: '125.00' }] }
      }
      if (sql.includes('INSERT INTO video_registros')) {
        return { rows: [{
          id: 'video-1',
          marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          data: '2026-05-20',
          quantidade: 1,
          gmv_atribuido: '1000.00',
          pedidos_atribuidos: 8,
        }] }
      }
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await app.register(videosRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      payload: {
        marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        data: '2026-05-20',
        quantidade: 1,
        gmv_atribuido: 1000,
        pedidos_atribuidos: 8,
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().venda_atribuida).toMatchObject({ id: 'venda-1', origem: 'video' })
    const vendaCall = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO vendas_atribuidas'))
    expect(vendaCall).toBeTruthy()
    expect(vendaCall[1][1]).toBe('video')
    await app.close()
  })

  it('POST /v1/vendas-atribuidas blocks cliente_parceiro writes', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({ papel: 'cliente_parceiro', queryMock })
    await app.register(vendasAtribuidasRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vendas-atribuidas',
      payload: { origem: 'manual', valor_gmv: 100, quantidade_pedidos: 1 },
    })

    expect(res.statusCode).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('GET /v1/comissoes/resumo aggregates live and video attribution rows', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce({
      rows: [{
        gmv_total: '2000.00',
        pedidos_total: '15',
        registros: '3',
        comissao_apresentadoras: '225.00',
        comissao_franquia: '0',
        comissao_franqueadora: '0',
      }],
    })
    const { app } = buildApp({ queryMock })
    await app.register(comissoesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/resumo' })

    expect(res.statusCode).toBe(200)
    expect(res.json().totais).toMatchObject({
      gmv: 2000,
      pedidos: 15,
      comissao: 225,
      registros: 3,
    })
    expect(queryMock.mock.calls[0][0]).toContain('FROM vendas_atribuidas va')
    await app.close()
  })
})
