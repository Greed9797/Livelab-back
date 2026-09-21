import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { livesRoutes } from '../src/routes/lives.js'

const tenantId = 'tenant-1'
const marcaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const apresentadoraId = '66666666-6666-4666-8666-666666666666'
const liveId = '33333333-3333-4333-8333-333333333333'

function buildApp(query) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: '99999999-9999-4999-8999-999999999999', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('dbTenant', async () => ({ query, release: vi.fn() }))
  app.decorate('withTenant', async (_t, fn) => {
    const db = await app.dbTenant(_t)
    try { return await fn(db) } finally { db.release() }
  })
  app.decorate('audit', { log: vi.fn() })
  return app
}

describe('cabine opcional na live', () => {
  it('POST /v1/lives sem cabine grava NULL e não atualiza estação', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('FROM cabines')) throw new Error('não deveria consultar cabine')
      if (s.includes('FROM agenda_eventos') && s.includes('apresentadora_id')) return { rows: [] }
      if (s.includes('FROM marcas')) return { rows: [{ cliente_id: null, tipo: 'afiliada', tiktok_username: null }] }
      if (s.includes('FROM apresentadoras')) return { rows: [{ user_id: null }] }
      if (s.includes('INSERT INTO lives')) {
        return { rows: [{ id: liveId, cabine_id: null, iniciado_em: '2026-09-21T18:00:00.000Z', cliente_id: null, apresentador_id: null, tipo: 'afiliado', marca_id: marcaId }] }
      }
      if (s.includes('INSERT INTO agenda_eventos')) return { rows: [{ id: 'agenda-1' }] }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives',
      payload: { marca_id: marcaId, apresentadora_id: apresentadoraId, tipo: 'afiliado' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().cabine_id).toBeNull()
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO lives'))
    expect(insert[1][1]).toBeNull()
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE cabines'))).toBe(false)
    await app.close()
  })

  it('POST /v1/lives/manual sem fonte de comissão grava NULL, não 0', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('FROM cabines')) throw new Error('não deveria consultar cabine')
      if (s.includes('comissao_confirmada')) return { rows: [{ condicao_pct: null, marca_pct: 0 }] }
      if (s.includes('FROM marcas') && !s.includes('comissao_confirmada')) {
        return { rows: [{ id: marcaId, cliente_id: null, tipo: 'afiliada' }] }
      }
      if (s.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: 0 }] }
      if (s.includes('INSERT INTO lives')) return { rows: [{ id: liveId }] }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: {
        marca_id: marcaId,
        tipo: 'afiliado',
        data: '2026-09-21',
        hora_inicio: '18:00',
        hora_fim: '20:00',
        fat_gerado: 1000,
        qtd_pedidos: 4,
      },
    })

    expect(res.statusCode).toBe(201)
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO lives'))
    expect(insert[1][1]).toBeNull()
    expect(insert[1][8]).toBeNull()
    await app.close()
  })

  it('POST /v1/lives/manual sem cabine usa o percentual confirmado da marca', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('comissao_confirmada')) return { rows: [{ condicao_pct: '10', marca_pct: 0 }] }
      if (s.includes('FROM marcas')) return { rows: [{ id: marcaId, cliente_id: null, tipo: 'afiliada' }] }
      if (s.includes('INSERT INTO lives')) return { rows: [{ id: liveId }] }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: {
        marca_id: marcaId,
        tipo: 'afiliado',
        data: '2026-09-21',
        hora_inicio: '18:00',
        hora_fim: '20:00',
        fat_gerado: 1000,
        qtd_pedidos: 4,
      },
    })

    expect(res.statusCode).toBe(201)
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO lives'))
    expect(insert[1][8]).toBeCloseTo(100)
    await app.close()
  })

  it('PATCH sem cabine e sem fonte deixa comissao_calculada nula', async () => {
    const query = vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('FROM lives')) {
        return { rows: [{ id: liveId, status: 'encerrada', cabine_id: null, marca_id: null, apresentador_id: null, fat_gerado: '1000', iniciado_em: '2026-09-21T18:00:00Z' }] }
      }
      if (s.includes('FROM cabines')) throw new Error('não deveria consultar cabine')
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}`,
      payload: { fat_gerado: 2000 },
    })

    expect(res.statusCode).toBe(200)
    const update = query.mock.calls.find(([sql]) => /UPDATE lives SET/i.test(String(sql)))
    expect(String(update[0])).toContain('comissao_calculada')
    expect(update[1]).toContain(null)
    expect(update[1]).not.toContain(0)
    await app.close()
  })

  it('resumo-dia faz LEFT JOIN em cabines e mantém m.id AS marca_id', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const app = buildApp(query)
    app.decorate('cache', { invalidate: async () => {}, get: async () => null, set: async () => {} })
    await app.register(livesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/lives/resumo-dia?data=2026-09-21' })
    expect(res.statusCode).toBe(200)
    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('LEFT JOIN cabines c ON c.id = l.cabine_id')
    expect(sql).not.toMatch(/(?<!LEFT )JOIN cabines c ON c.id = l.cabine_id/)
    expect(sql).toContain('m.id AS marca_id')
    await app.close()
  })
})
