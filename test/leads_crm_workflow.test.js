import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { leadsRoutes } from '../src/routes/leads.js'

function buildLeadsApp(queryMock) {
  const app = Fastify()
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel: 'franqueado', nome: 'Franqueado QA' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })
  app.decorate('db', { pool: { connect: vi.fn() } })
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })

  return { app, release }
}

describe('CRM lead workflow', () => {
  it('creates a lead with email, WhatsApp and internal notes', async () => {
    let insertArgs = null
    const queryMock = vi.fn(async (sql, args) => {
      if (sql.includes('INSERT INTO leads')) {
        insertArgs = args
        return {
          rows: [{
            id: 'lead-1',
            nome: 'Marca QA',
            contato_email: 'qa@marca.com',
            contato_whatsapp: '47999999999',
            observacoes_internas: 'Lead quente',
          }],
        }
      }
      return { rows: [] }
    })
    const { app } = buildLeadsApp(queryMock)
    await app.register(leadsRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/leads',
      payload: {
        nome: 'Marca QA',
        contato_email: 'qa@marca.com',
        contato_whatsapp: '47999999999',
        observacoes_internas: 'Lead quente',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(insertArgs).toContain('qa@marca.com')
    expect(insertArgs).toContain('47999999999')
    expect(insertArgs).toContain('Lead quente')
    await app.close()
  })

  it('requires motivo_perda when moving a lead to perdido', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('SELECT id, crm_etapa')) return { rows: [{ id: 'lead-1', crm_etapa: 'em_negociacao', motivo_perda: null }] }
      return { rows: [] }
    })
    const { app } = buildLeadsApp(queryMock)
    await app.register(leadsRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/leads/lead-1',
      payload: { crm_etapa: 'perdido' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'LEAD_LOSS_REASON_REQUIRED' })
    await app.close()
  })

  it('records structured stage history when crm_etapa changes', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('SELECT id, crm_etapa')) return { rows: [{ id: 'lead-1', crm_etapa: 'lead_novo', motivo_perda: null }] }
      if (sql.includes('UPDATE leads SET')) return { rows: [{ id: 'lead-1', crm_etapa: 'contato_iniciado' }] }
      if (sql.includes('INSERT INTO lead_etapa_historico')) return { rows: [{ id: 'hist-1' }] }
      return { rows: [] }
    })
    const { app } = buildLeadsApp(queryMock)
    await app.register(leadsRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/leads/lead-1',
      payload: { crm_etapa: 'contato_iniciado' },
    })

    expect(response.statusCode).toBe(200)
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO lead_etapa_historico'))).toBe(true)
    await app.close()
  })

  it('stores contacts and tasks in structured tables while keeping JSONB compatibility', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('SELECT id FROM leads')) return { rows: [{ id: 'lead-1' }] }
      if (sql.includes('INSERT INTO lead_contatos')) return { rows: [{ id: 'contato-1' }] }
      if (sql.includes('INSERT INTO lead_tarefas')) return { rows: [{ id: 'tarefa-1' }] }
      if (sql.includes('UPDATE leads') && sql.includes('historico_contatos')) return { rows: [{ id: 'lead-1', historico_contatos: [{ resumo: 'Ligação' }] }] }
      if (sql.includes('UPDATE leads') && sql.includes('tarefas')) return { rows: [{ id: 'lead-1', tarefas: [{ titulo: 'Enviar proposta' }] }] }
      return { rows: [] }
    })
    const { app } = buildLeadsApp(queryMock)
    await app.register(leadsRoutes)

    const contato = await app.inject({
      method: 'POST',
      url: '/v1/leads/lead-1/contato',
      payload: { tipo: 'whatsapp', resumo: 'Ligação' },
    })
    const tarefa = await app.inject({
      method: 'POST',
      url: '/v1/leads/lead-1/tarefa',
      payload: { titulo: 'Enviar proposta', due_date: '2026-05-20' },
    })

    expect(contato.statusCode).toBe(200)
    expect(tarefa.statusCode).toBe(200)
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO lead_contatos'))).toBe(true)
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO lead_tarefas'))).toBe(true)
    await app.close()
  })

  it('converts a lead already in ganho when it has no linked client', async () => {
    const writes = []
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('SELECT set_config')) return { rows: [] }
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
        if (sql.includes('SELECT * FROM leads')) return { rows: [{
          id: 'lead-1', nome: 'Marca QA', crm_etapa: 'ganho', convertido_cliente_id: null,
          nicho: null, cidade: null, estado: null, lat: null, lng: null, fat_estimado: 100,
        }] }
        if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) writes.push(sql)
        if (sql.includes('INSERT INTO clientes')) return { rows: [{ id: 'cliente-1' }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const { app } = buildLeadsApp(vi.fn())
    app.db.pool.connect.mockResolvedValue(client)
    await app.register(leadsRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/leads/lead-1/ganhar', payload: {} })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, cliente_id: 'cliente-1' })
    expect(writes.filter((sql) => sql.includes('INSERT INTO clientes'))).toHaveLength(1)
    expect(writes.filter((sql) => sql.includes('INSERT INTO contratos'))).toHaveLength(1)
    expect(writes.filter((sql) => sql.includes('UPDATE leads'))).toHaveLength(1)
    await app.close()
  })

  it('blocks conversion when a linked client exists, regardless of CRM stage', async () => {
    const writes = []
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('SELECT set_config')) return { rows: [] }
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
        if (sql.includes('SELECT * FROM leads')) return { rows: [{
          id: 'lead-1', crm_etapa: 'em_negociacao', convertido_cliente_id: 'cliente-existente',
        }] }
        if (sql.includes('INSERT INTO clientes')) return { rows: [{ id: 'cliente-2' }] }
        if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) writes.push(sql)
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const { app } = buildLeadsApp(vi.fn())
    app.db.pool.connect.mockResolvedValue(client)
    await app.register(leadsRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/leads/lead-1/ganhar', payload: {} })

    expect(response.statusCode).toBe(409)
    expect(writes).toEqual([])
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    await app.close()
  })

  it('does not write when the lead belongs to another tenant', async () => {
    const writes = []
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('SELECT set_config')) return { rows: [] }
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
        if (sql.includes('SELECT * FROM leads')) return { rows: [] }
        if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) writes.push(sql)
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const { app } = buildLeadsApp(vi.fn())
    app.db.pool.connect.mockResolvedValue(client)
    await app.register(leadsRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/leads/lead-for-other-tenant/ganhar', payload: {} })

    expect(response.statusCode).toBe(404)
    expect(writes).toEqual([])
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    await app.close()
  })
})
