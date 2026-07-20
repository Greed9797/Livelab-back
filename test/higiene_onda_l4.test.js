// Higiene Onda 1 — L4-2 (nome de marca único por tenant), L4-3 (enum de status
// de cliente), L4-4 (formato ano_mes).
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { marcasRoutes } from '../src/routes/marcas.js'
import { clientesRoutes } from '../src/routes/clientes.js'
import { metasRoutes } from '../src/routes/metas.js'
import { ANO_MES_RE, anoMesRange, isAnoMes } from '../src/lib/ano-mes.js'

function buildApp(queryMock) {
  const app = Fastify()
  const releaseMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('db', { query: queryMock })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })

  return app
}

/** Router de mock por SQL: casa o primeiro predicado que bate. */
function routedQuery(routes, fallback = { rows: [] }) {
  return vi.fn(async (sql) => {
    const text = typeof sql === 'string' ? sql : String(sql)
    for (const [match, result] of routes) {
      if (match.test(text)) return typeof result === 'function' ? result() : result
    }
    return fallback
  })
}

describe('L4-2 — nome de marca único por tenant', () => {
  it('POST /v1/marcas devolve 409 em pt-BR quando o nome já existe no tenant', async () => {
    const queryMock = routedQuery([
      [/lower\(nome\) = lower/, { rows: [{ '?column?': 1 }] }],
    ])
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/marcas',
      payload: { nome: 'Boca Rosa', tipo: 'afiliada' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Já existe uma marca com este nome/)
    // não pode ter chegado ao INSERT
    const sqls = queryMock.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((s) => /INSERT INTO marcas/.test(s))).toBe(false)
    expect(sqls.at(-1)).toBe('ROLLBACK')
  })

  it('POST /v1/marcas segue normal quando o nome é livre', async () => {
    const queryMock = routedQuery([
      [/lower\(nome\) = lower/, { rows: [] }],
      [/INSERT INTO marcas/, { rows: [{ id: 'marca-1', nome: 'Boca Rosa', tipo: 'afiliada' }] }],
    ])
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/marcas',
      payload: { nome: 'Boca Rosa', tipo: 'afiliada' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().id).toBe('marca-1')
  })

  it('PATCH /v1/marcas/:id devolve 409 ao renomear para um nome já usado', async () => {
    const queryMock = routedQuery([
      [/lower\(nome\) = lower/, { rows: [{ '?column?': 1 }] }],
    ])
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/marcas/marca-1',
      payload: { nome: 'Boca Rosa' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Já existe uma marca com este nome/)
    const sqls = queryMock.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((s) => /UPDATE marcas SET/.test(s))).toBe(false)
  })

  it('PATCH que não mexe no nome não dispara a checagem de unicidade', async () => {
    const queryMock = routedQuery([
      [/UPDATE marcas SET/, { rows: [{ id: 'marca-1', tipo: 'afiliada', cliente_id: null }] }],
    ])
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/marcas/marca-1',
      payload: { comissao_franquia_pct: 7 },
    })

    expect(response.statusCode).toBe(200)
    const sqls = queryMock.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((s) => /lower\(nome\) = lower/.test(s))).toBe(false)
  })

  it('traduz 23505 do índice único (corrida) em 409, e não em 500', async () => {
    const violation = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uniq_marca_nome_por_tenant',
    })
    const queryMock = vi.fn(async (sql) => {
      const text = String(sql)
      if (/lower\(nome\) = lower/.test(text)) return { rows: [] }
      if (/INSERT INTO marcas/.test(text)) throw violation
      return { rows: [] }
    })
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/marcas',
      payload: { nome: 'Boca Rosa', tipo: 'afiliada' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Já existe uma marca com este nome/)
  })

  it('não mascara 23505 de outra constraint da tabela', async () => {
    const violation = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uniq_marca_cliente_por_tenant',
    })
    const queryMock = vi.fn(async (sql) => {
      const text = String(sql)
      if (/lower\(nome\) = lower/.test(text)) return { rows: [] }
      if (/INSERT INTO marcas/.test(text)) throw violation
      return { rows: [] }
    })
    const app = buildApp(queryMock)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/marcas',
      payload: { nome: 'Boca Rosa', tipo: 'afiliada' },
    })

    expect(response.statusCode).toBe(500)
  })
})

describe('L4-3 — enum de status de cliente', () => {
  it('PATCH /v1/clientes/:id rejeita status fora do enum com 400 em pt-BR', async () => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(clientesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/clientes/cliente-1',
      payload: { status: 'status_que_nao_existe' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/status inválido/)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('rejeita também os status legados que só existem no CHECK do banco', async () => {
    const app = buildApp(vi.fn())
    await app.register(clientesRoutes)

    for (const morto of ['enviado', 'em_analise', 'aprovado', 'risco_assumido']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/clientes/cliente-1',
        payload: { status: morto },
      })
      expect(response.statusCode, `status legado ${morto} deveria ser rejeitado`).toBe(400)
    }
  })

  it('aceita os status vivos e mantém o alias ganho → onboarding', async () => {
    const queryMock = routedQuery([
      [/UPDATE clientes SET/, { rows: [{ id: 'cliente-1', nome: 'ACME', status: 'onboarding', onboarding_step: 1 }] }],
    ])
    const app = buildApp(queryMock)
    await app.register(clientesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/clientes/cliente-1',
      payload: { status: 'ganho' },
    })

    expect(response.statusCode).toBe(200)
    const updateCall = queryMock.mock.calls.find((c) => /UPDATE clientes SET/.test(String(c[0])))
    expect(updateCall[1]).toContain('onboarding')
    expect(updateCall[1]).not.toContain('ganho')
  })

  it('aceita inadimplente (lido por lives.js) e cancelado_automaticamente (job de cleanup)', async () => {
    const queryMock = routedQuery([
      [/UPDATE clientes SET/, { rows: [{ id: 'cliente-1', status: 'inadimplente' }] }],
    ])
    const app = buildApp(queryMock)
    await app.register(clientesRoutes)

    for (const vivo of ['inadimplente', 'cancelado_automaticamente', 'negociacao', 'arquivado']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/clientes/cliente-1',
        payload: { status: vivo },
      })
      expect(response.statusCode, `status vivo ${vivo} deveria ser aceito`).toBe(200)
    }
  })
})

describe('L4-4 — formato ano_mes', () => {
  it('ANO_MES_RE aceita AAAA-MM válido e recusa o resto', () => {
    expect(ANO_MES_RE.test('2026-07')).toBe(true)
    expect(isAnoMes('2026-01')).toBe(true)
    expect(isAnoMes('2026-12')).toBe(true)

    expect(isAnoMes('2026-13')).toBe(false)
    expect(isAnoMes('2026-00')).toBe(false)
    expect(isAnoMes('2026-7')).toBe(false)
    expect(isAnoMes('2026-07-01')).toBe(false)
    expect(isAnoMes('julho')).toBe(false)
    expect(isAnoMes(202607)).toBe(false)
  })

  it('anoMesRange vira o ano em dezembro', () => {
    expect(anoMesRange('2026-07')).toEqual({ inicio: '2026-07-01', proximo: '2026-08-01' })
    expect(anoMesRange('2026-12')).toEqual({ inicio: '2026-12-01', proximo: '2027-01-01' })
  })

  const rotas = [
    ['GET', '/v1/metas/apresentadoras', undefined],
    ['GET', '/v1/metas/supervisor', undefined],
    ['PUT', '/v1/metas/apresentadoras/apres-1', { gmv_meta: 1000 }],
    ['PUT', '/v1/metas/supervisor', { gmv_meta_total: 5000 }],
  ]

  for (const [method, url, payload] of rotas) {
    it(`${method} ${url} rejeita ?mes malformado com 400`, async () => {
      const queryMock = vi.fn().mockResolvedValue({ rows: [] })
      const app = buildApp(queryMock)
      await app.register(metasRoutes)

      const response = await app.inject({ method, url: `${url}?mes=2026-13`, payload })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toMatch(/AAAA-MM/)
      expect(queryMock).not.toHaveBeenCalled()
    })
  }

  it('GET /v1/metas/apresentadoras usa range sargável em vez de to_char', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const app = buildApp(queryMock)
    await app.register(metasRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/metas/apresentadoras?mes=2026-12' })

    expect(response.statusCode).toBe(200)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).not.toContain("to_char(va.data")
    expect(sql).toContain('va.data >=')
    expect(sql).toContain('va.data <')
    expect(params).toEqual(['tenant-uuid-1', '2026-12-01', '2026-12-01', '2027-01-01'])
  })

  it('GET /v1/metas/supervisor usa range sargável em vez de to_char', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const app = buildApp(queryMock)
    await app.register(metasRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/metas/supervisor?mes=2026-03' })

    expect(response.statusCode).toBe(200)
    const gmvCall = queryMock.mock.calls.find(([sql]) => /vendas_atribuidas/.test(sql))
    expect(gmvCall[0]).not.toContain('to_char(')
    expect(gmvCall[1]).toEqual(['tenant-uuid-1', '2026-03-01', '2026-04-01'])
  })

  it('?mes ausente cai no mês corrente sem 400', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const app = buildApp(queryMock)
    await app.register(metasRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/metas/supervisor' })
    expect(response.statusCode).toBe(200)
  })
})
