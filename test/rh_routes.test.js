import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { rhRoutes } from '../src/routes/rh.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const colaboradorId = '22222222-2222-4222-8222-222222222222'
const folhaId = '33333333-3333-4333-8333-333333333333'

function buildApp(handler = () => ({ rows: [] })) {
  const app = Fastify()
  const calls = []

  const query = vi.fn(async (sql, params = []) => {
    const text = String(sql)
    calls.push({ sql: text, params })
    return handler(text, params)
  })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'gerente' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'gerente' }
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })

  return { app, query, calls }
}

describe('RH routes', () => {
  it('GET /v1/rh/colaboradores lists rows filtered by tenant', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('FROM rh_colaboradores')) {
        return { rows: [{ id: 'c1', nome: 'Ana', ativo: true }] }
      }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({ method: 'GET', url: '/v1/rh/colaboradores' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0].nome).toBe('Ana')
    expect(calls[0].sql).toContain('tenant_id = $1::uuid')
    expect(calls[0].sql).toContain('ORDER BY ativo DESC, nome ASC')
    expect(calls[0].params).toEqual([tenantId])
    await app.close()
  })

  it('POST /v1/rh/colaboradores rejects missing nome with 400', async () => {
    const { app, query } = buildApp()
    await rhRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rh/colaboradores',
      payload: { cargo: 'Vendedor' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('error', 'Nome é obrigatório')
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('POST /v1/rh/colaboradores rejects impossible calendar date with 400', async () => {
    const { app, query } = buildApp()
    await rhRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rh/colaboradores',
      payload: { nome: 'Ana', data_admissao: '2026-02-31' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('error', 'Data inválida (YYYY-MM-DD).')
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('POST /v1/rh/colaboradores creates with 201 and tenant scope', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('INSERT INTO rh_colaboradores')) {
        return { rows: [{ id: 'new-1', nome: 'Ana', salario_fixo: '1500.50', ativo: true }] }
      }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rh/colaboradores',
      payload: {
        nome: 'Ana', cargo: 'Vendedora', salario_fixo: 1500.5, comissao_pct: 5,
        data_admissao: '2026-01-05', status: 'ferias', tipo_contrato: 'pj',
        centro_custo: ['Lives'], responsavel_id: null,
        ote_comissao: 'R$ 2.500 + comissão', chave_pix: 'x',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe('new-1')
    const insert = calls.find((c) => c.sql.includes('INSERT INTO rh_colaboradores'))
    expect(insert.params[0]).toBe(tenantId)
    expect(insert.params[1]).toBe('Ana')
    expect(insert.params[8]).toBe('2026-01-05')
    expect(insert.params[10]).toBe(1500.5)
    expect(insert.params[11]).toBe(5)
    expect(insert.params[12]).toBe(true) // status ferias continua ativo
    expect(insert.params[14]).toBe('ferias')
    expect(insert.params[15]).toBe('pj')
    expect(insert.params[16]).toEqual(['Lives'])
    expect(insert.params[17]).toBeNull()
    expect(insert.params[18]).toBe('R$ 2.500 + comissão')
    expect(insert.params[19]).toBe('x')
    expect(insert.sql).toContain('comissao_pct')
    expect(insert.sql).toContain('status')
    expect(insert.sql).toContain('RETURNING *')
    await app.close()
  })

  it('PATCH /v1/rh/colaboradores/:id sincroniza ativo=false em status=inativo', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('UPDATE rh_colaboradores')) return { rows: [{ id: colaboradorId, ativo: false, status: 'inativo' }] }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/rh/colaboradores/${colaboradorId}`,
      payload: { ativo: false },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('inativo')
    const update = calls.find((c) => c.sql.includes('UPDATE rh_colaboradores'))
    expect(update.sql).toContain('ativo = $')
    expect(update.sql).toContain('status = $')
    expect(update.params).toEqual([colaboradorId, tenantId, false, 'inativo'])
    await app.close()
  })

  it('PATCH /v1/rh/colaboradores/:id rejeita responsável por si mesmo', async () => {
    const { app, query } = buildApp()
    await rhRoutes(app)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/rh/colaboradores/${colaboradorId}`,
      payload: { responsavel_id: colaboradorId },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Colaborador não pode ser responsável por si mesmo.' })
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('PATCH /v1/rh/colaboradores/:id rejeita ciclo de gestão sem UPDATE', async () => {
    const b = '44444444-4444-4444-8444-444444444444'
    const c = '55555555-5555-4555-8555-555555555555'
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('SELECT id, responsavel_id FROM rh_colaboradores')) {
        return { rows: [
          { id: colaboradorId, responsavel_id: b },
          { id: b, responsavel_id: c },
          { id: c, responsavel_id: colaboradorId },
        ] }
      }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/rh/colaboradores/${colaboradorId}`,
      payload: { responsavel_id: c },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Vínculo criaria um ciclo de gestão.' })
    expect(calls.some((c2) => c2.sql.includes('UPDATE rh_colaboradores'))).toBe(false)
    await app.close()
  })

  it('POST /v1/rh/colaboradores sem status e ativo=false grava status inativo', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('INSERT INTO rh_colaboradores')) return { rows: [{ id: 'new-2', nome: 'Sem status', ativo: false, status: 'inativo' }] }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rh/colaboradores',
      payload: { nome: 'Sem status', ativo: false },
    })

    expect(res.statusCode).toBe(201)
    const insert = calls.find((c) => c.sql.includes('INSERT INTO rh_colaboradores'))
    expect(insert.params[12]).toBe(false)
    expect(insert.params[14]).toBe('inativo')
    await app.close()
  })

  it('PATCH /v1/rh/colaboradores/:id aceita campos opcionais nulos', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('UPDATE rh_colaboradores')) return { rows: [{ id: colaboradorId, nome: 'Ana' }] }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/rh/colaboradores/${colaboradorId}`,
      payload: {
        cargo: null, setor: null, email: null, telefone: null, cpf: null,
        observacoes: null, data_nascimento: null, responsavel_id: null,
        centro_custo: null, ote_comissao: null, chave_pix: null,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(colaboradorId)
    expect(calls.some((c) => c.sql.includes('UPDATE rh_colaboradores'))).toBe(true)
    await app.close()
  })

  it('POST /v1/rh/colaboradores aceita campos opcionais nulos', async () => {
    const { app } = buildApp((sql) => {
      if (sql.includes('INSERT INTO rh_colaboradores')) return { rows: [{ id: 'new-null', nome: 'Ana' }] }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rh/colaboradores',
      payload: {
        nome: 'Ana', cargo: null, setor: null, email: null, telefone: null,
        cpf: null, observacoes: null, data_nascimento: null, responsavel_id: null,
        centro_custo: null, ote_comissao: null, chave_pix: null,
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe('new-null')
    await app.close()
  })

  it('GET /v1/rh/folha sums totais and uses first-day competencia', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('FROM rh_colaboradores c')) {
        return {
          rows: [
            { colaborador_id: 'c1', nome: 'Ana', ativo: true, total: '1100.00', salario_fixo: '1000.00', comissao: '100.00' },
            { colaborador_id: 'c2', nome: 'Bruno', ativo: true, total: '900.50', salario_fixo: '800.00', comissao: '100.50' },
          ],
        }
      }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({ method: 'GET', url: '/v1/rh/folha?mes=2026-11' })

    expect(res.statusCode).toBe(200)
    expect(res.json().mes).toBe('2026-11')
    expect(res.json().colaboradores).toHaveLength(2)
    expect(res.json().totais.total).toBe(2000.5)
    expect(res.json().totais.salario_fixo).toBe(1800)
    expect(calls[0].params).toEqual([tenantId, '2026-11-01'])
    await app.close()
  })

  it('GET /v1/rh/folha rejects invalid mes with 400', async () => {
    const { app } = buildApp()
    await rhRoutes(app)

    const res = await app.inject({ method: 'GET', url: '/v1/rh/folha?mes=2026-13' })

    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('PUT /v1/rh/folha/:id returns 409 when existing folha is pago', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('SELECT status FROM rh_folha_mensal')) return { rows: [{ status: 'pago' }] }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/rh/folha/${colaboradorId}`,
      payload: { mes: '2026-11', comissao: 100 },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'Folha paga não pode ser editada.' })
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual([tenantId, colaboradorId, '2026-11-01'])
    await app.close()
  })

  it('PUT /v1/rh/folha/:id uses cadastro salario when omitted and upserts', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('SELECT status FROM rh_folha_mensal')) return { rows: [] }
      if (sql.includes('SELECT salario_fixo FROM rh_colaboradores')) return { rows: [{ salario_fixo: '2500.00' }] }
      if (sql.includes('INSERT INTO rh_folha_mensal')) {
        return { rows: [{ id: folhaId, total: '2600.00', status: 'rascunho' }] }
      }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/rh/folha/${colaboradorId}`,
      payload: { mes: '2026-11', comissao: 100 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe('2600.00')
    const insert = calls.find((c) => c.sql.includes('INSERT INTO rh_folha_mensal'))
    expect(insert.params[3]).toBe(2500)
    expect(insert.params[6]).toBe(100)
    await app.close()
  })

  it('PATCH /v1/rh/folha/:id/status updates status with 200', async () => {
    const { app, calls } = buildApp((sql) => {
      if (sql.includes('UPDATE rh_folha_mensal')) return { rows: [{ id: folhaId, status: 'fechado' }] }
      return { rows: [] }
    })
    await rhRoutes(app)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/rh/folha/${folhaId}/status`,
      payload: { status: 'fechado' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('fechado')
    expect(calls[0].sql).toContain("fechado_em = CASE WHEN $3 = 'fechado' THEN NOW()")
    expect(calls[0].sql).toContain("pago_em = CASE WHEN $3 = 'pago' THEN NOW()")
    expect(calls[0].params).toEqual([folhaId, tenantId, 'fechado'])
    await app.close()
  })
})
