import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'
import { marcasRoutes, buildConfiguracaoComercial } from '../src/routes/marcas.js'

const tenantId = '00000000-0000-4000-8000-000000000001'
const marcaId = '00000000-0000-4000-8000-000000000002'
const clienteId = '00000000-0000-4000-8000-000000000004'
const outraMarcaId = '00000000-0000-4000-8000-000000000099'

function buildApp(query, { viaApiKey = false } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: '00000000-0000-4000-8000-000000000003', papel: 'franqueado' }
    if (viaApiKey) request.viaApiKey = { id: '00000000-0000-4000-8000-000000000088' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('db', { query })
  app.decorate('audit', { log: vi.fn(async () => {}) })
  return app
}

function queryCondicao({ existingIdempotency = null, onInsert } = {}) {
  return vi.fn(async (sql, params = []) => {
    const text = String(sql)
    if (text === 'BEGIN' || text.startsWith('BEGIN TRANSACTION') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] }
    if (text.includes('comercial_origem') || text.includes('gmv_mes')) return { rows: [] }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (text.includes('FROM marcas') && text.includes('FOR UPDATE')) return { rows: [{ id: marcaId }] }
    if (text.includes('idempotency_key') && text.includes('FOR UPDATE')) {
      return { rows: existingIdempotency ? [existingIdempotency] : [] }
    }
    if (text.includes('FROM marca_condicoes_comerciais') && text.includes('ORDER BY')) {
      return {
        rows: [{
          id: 'baseline', inicio_vigencia: '1900-01-01', fixo_mensal: '0.00',
          comissao_franquia_pct: '0.00', comissao_franqueadora_pct: '0.00',
          tipo_cobranca: 'fixo_mais_comissao', fixo_confirmado: false,
          comissao_confirmada: false, origem: 'legado_nao_verificado', revision: 1,
        }],
      }
    }
    if (text.includes('COUNT(*) FILTER') && text.includes('FROM lives')) return { rows: [{ fechados: 0, abertos: 0, gmv_aberto: '0' }] }
    if (text.includes('COUNT(*) FILTER') && text.includes('FROM vendas_atribuidas')) return { rows: [{ fechados: 0, abertos: 0, gmv_aberto: '0' }] }
    if (text.includes('MAX(competencia)')) return { rows: [{ ultima_competencia: null }] }
    if (text.includes('GROUP BY va.data')) return { rows: [] }
    if (text.includes('INSERT INTO marca_condicoes_comerciais')) {
      onInsert?.(params)
      return {
        rows: [{
          id: 'cond-1', inicio_vigencia: '2026-09-01', fixo_mensal: String(params[3]),
          comissao_franquia_pct: '0.00', comissao_franqueadora_pct: '0.00',
          tipo_cobranca: 'fixo_mais_comissao', fixo_confirmado: params[7],
          comissao_confirmada: params[8], origem: params[9], revision: 2,
          payload_hash: params.at(-1),
        }],
      }
    }
    return { rows: [], rowCount: 0 }
  })
}

const propostaZero = {
  inicio_vigencia: '2026-09',
  fixo_mensal: 0,
  comissao_franquia_pct: 0,
  comissao_franqueadora_pct: 0,
  fixo_confirmado: true,
  comissao_confirmada: true,
  origem: 'legado_nao_verificado',
  idempotency_key: 'chave-no-body',
  expected_revision: 1,
}

describe('rotas de condições comerciais', () => {
  beforeEach(() => _clearDashboardCache())

  it('lista histórico por tenant e não expõe o PATCH financeiro legado', async () => {
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('FROM marcas') && text.includes('SELECT id')) return { rows: [{ id: marcaId }] }
      if (text.includes('FROM marca_condicoes_comerciais')) return {
        rows: [{ id: 'condition-1', inicio_vigencia: '2026-08-01', fixo_mensal: '1000.00', revision: 1 }],
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(marcasRoutes)

    const history = await app.inject({ method: 'GET', url: `/v1/marcas/${marcaId}/condicoes` })
    expect(history.statusCode).toBe(200)
    expect(history.json()[0]).toMatchObject({
      inicio_vigencia: '2026-08-01',
      competencia: '2026-08',
      fixo_mensal: 1000,
    })
    const lookup = query.mock.calls.find(([sql]) => String(sql).includes('SELECT id FROM marcas'))
    expect(lookup[1]).toEqual([tenantId, marcaId])

    const patch = await app.inject({
      method: 'PATCH', url: `/v1/marcas/${marcaId}`,
      payload: { comissao_franquia_pct: 8 },
    })
    expect(patch.statusCode).toBe(409)
    expect(patch.json()).toMatchObject({ code: 'USE_MARCA_CONDITION_ENDPOINT' })
    await app.close()
  })

  it('histórico vazio de marca existente é 200 e uuid desconhecido é 404', async () => {
    const query = vi.fn(async (sql, params) => {
      const text = String(sql)
      if (text.includes('SELECT id FROM marcas')) {
        return { rows: params[1] === marcaId ? [{ id: marcaId }] : [] }
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(marcasRoutes)

    const vazio = await app.inject({ method: 'GET', url: `/v1/marcas/${marcaId}/condicoes` })
    expect(vazio.statusCode).toBe(200)
    expect(vazio.json()).toEqual([])

    const ausente = await app.inject({ method: 'GET', url: `/v1/marcas/${outraMarcaId}/condicoes` })
    expect(ausente.statusCode).toBe(404)
    expect(ausente.json()).toMatchObject({ code: 'MARCA_NOT_FOUND' })
    const lookups = query.mock.calls.filter(([sql]) => String(sql).includes('SELECT id FROM marcas'))
    expect(lookups.every(([, params]) => params[0] === tenantId)).toBe(true)
    await app.close()
  })

  it('exige o header Idempotency-Key e ignora a chave no body', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const app = buildApp(query)
    await app.register(marcasRoutes)

    const semHeader = await app.inject({
      method: 'POST', url: `/v1/marcas/${marcaId}/condicoes`,
      payload: { ...propostaZero, idempotency_key: 'so-no-body' },
    })
    expect(semHeader.statusCode).toBe(400)
    expect(semHeader.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    expect(query).not.toHaveBeenCalled()

    const semRevisao = await app.inject({
      method: 'POST', url: `/v1/marcas/${marcaId}/condicoes`,
      headers: { 'idempotency-key': 'header-key' },
      payload: { inicio_vigencia: '2026-09', fixo_mensal: 1200, comissao_franquia_pct: 8 },
    })
    expect(semRevisao.statusCode).toBe(409)
    expect(semRevisao.json()).toMatchObject({ code: 'EXPECTED_REVISION_REQUIRED' })
    await app.close()
  })

  it('grava origem do servidor e mantém zero confirmado como configurado', async () => {
    let inserted = null
    const query = queryCondicao({ onInsert: (params) => { inserted = params } })
    const app = buildApp(query)
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'POST', url: `/v1/marcas/${marcaId}/condicoes`,
      headers: { 'idempotency-key': 'header-key' },
      payload: propostaZero,
    })
    expect(response.statusCode).toBe(201)
    expect(inserted[9]).toBe('gestao')
    expect(inserted[13]).toBe('header-key')
    expect(inserted).not.toContain('legado_nao_verificado')
    expect(inserted).not.toContain('chave-no-body')
    expect(inserted[3]).toBe(0)
    expect(inserted[7]).toBe(true)
    expect(inserted[8]).toBe(true)
    expect(buildConfiguracaoComercial({
      tipo: 'cliente',
      condicao: {
        origem: inserted[9],
        fixo_mensal: 0,
        comissao_franquia_pct: 0,
        fixo_confirmado: true,
        comissao_confirmada: true,
      },
    }).status).toBe('configurado')
    await app.close()
  })

  it('chave de API grava origem bot e não a origem enviada', async () => {
    let inserted = null
    const query = queryCondicao({ onInsert: (params) => { inserted = params } })
    const app = buildApp(query, { viaApiKey: true })
    await app.register(marcasRoutes)

    const response = await app.inject({
      method: 'POST', url: `/v1/marcas/${marcaId}/condicoes`,
      headers: { 'idempotency-key': 'bot-key' },
      payload: propostaZero,
    })
    expect(response.statusCode).toBe(201)
    expect(inserted[9]).toBe('bot')
    expect(response.json().condition.origem).toBe('bot')
    await app.close()
  })

  it('a mesma Idempotency-Key no header replaya a condição', async () => {
    const existente = {
      id: 'cond-1', inicio_vigencia: '2026-09-01', fixo_mensal: '0.00',
      comissao_franquia_pct: '0.00', comissao_franqueadora_pct: '0.00',
      tipo_cobranca: 'fixo_mais_comissao', fixo_confirmado: true, comissao_confirmada: true,
      origem: 'gestao', revision: 2,
    }
    let primeira = null
    const query = queryCondicao({
      onInsert: (params) => {
        primeira = params
        existente.payload_hash = params.at(-1)
      },
    })
    const app = buildApp(query)
    await app.register(marcasRoutes)
    const headers = { 'idempotency-key': 'replay-key' }
    const criada = await app.inject({
      method: 'POST', url: `/v1/marcas/${marcaId}/condicoes`, headers, payload: propostaZero,
    })
    expect(criada.statusCode).toBe(201)

    const replay = vi.fn(async (sql, params = []) => {
      const text = String(sql)
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('FROM marcas') && text.includes('FOR UPDATE')) return { rows: [{ id: marcaId }] }
      if (text.includes('idempotency_key') && text.includes('FOR UPDATE')) {
        expect(params[2]).toBe('replay-key')
        return { rows: [{ ...existente, payload_hash: primeira.at(-1) }] }
      }
      if (text.includes('INSERT INTO marca_condicoes_comerciais')) throw new Error('replay não reinsere')
      return { rows: [] }
    })
    const appReplay = buildApp(replay)
    await appReplay.register(marcasRoutes)
    const deNovo = await appReplay.inject({
      method: 'POST', url: `/v1/marcas/${marcaId}/condicoes`, headers, payload: propostaZero,
    })
    expect(deNovo.statusCode).toBe(200)
    expect(deNovo.json().idempotent).toBe(true)
    expect(replay.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO marca_condicoes_comerciais'))).toBe(false)
    await app.close()
    await appReplay.close()
  })

  it('invalidar a listagem depois de confirmar faz o próximo GET perder o cache', async () => {
    const query = queryCondicao()
    const app = buildApp(query)
    await app.register(marcasRoutes)

    const primeiro = await app.inject({ method: 'GET', url: '/v1/marcas' })
    const segundo = await app.inject({ method: 'GET', url: '/v1/marcas' })
    expect(primeiro.headers['x-dashboard-cache']).toBe('MISS')
    expect(segundo.headers['x-dashboard-cache']).toBe('HIT')

    const confirmacao = await app.inject({
      method: 'POST', url: `/v1/marcas/${marcaId}/condicoes`,
      headers: { 'idempotency-key': 'cache-key' },
      payload: propostaZero,
    })
    expect(confirmacao.statusCode).toBe(201)

    const terceiro = await app.inject({ method: 'GET', url: '/v1/marcas' })
    expect(terceiro.headers['x-dashboard-cache']).toBe('MISS')
    await app.close()
  })

  it('POST com campo financeiro não insere marca', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const app = buildApp(query)
    await app.register(marcasRoutes)
    const response = await app.inject({
      method: 'POST', url: '/v1/marcas',
      payload: {
        nome: 'Marca parceira', tipo: 'parceira', valor_fixo_minimo: 900,
        comissao_franquia_pct: 7, comissao_franqueadora_pct: 1,
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      code: 'USE_MARCA_CONDITION_ENDPOINT',
      campos: expect.arrayContaining(['comissao_franquia_pct', 'valor_fixo_minimo']),
    })
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('cria a condição baseline na mesma transação para marca sem cliente', async () => {
    const inserted = {
      id: marcaId, tenant_id: tenantId, cliente_id: null, nome: 'Marca parceira',
      tipo: 'parceira', status: 'ativa', tipo_cobranca: 'fixo_mais_comissao',
    }
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('WITH nova_marca') && text.includes('INSERT INTO marcas')) return { rows: [inserted] }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(marcasRoutes)
    const response = await app.inject({
      method: 'POST', url: '/v1/marcas',
      payload: { nome: 'Marca parceira', tipo: 'parceira' },
    })
    expect(response.statusCode).toBe(201)
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('WITH nova_marca'))
    const sql = String(insert?.[0])
    const marcasInsert = sql.slice(sql.indexOf('INSERT INTO marcas'), sql.indexOf('RETURNING'))
    expect(marcasInsert).not.toContain('comissao_franquia_pct')
    expect(marcasInsert).not.toContain('valor_fixo_minimo')
    expect(sql).toContain('INSERT INTO marca_condicoes_comerciais')
    expect(sql).toContain("'legado_nao_verificado'")
    expect(sql).not.toContain('fixo_confirmado')
    expect(insert[1]).not.toContain(7)
    expect(insert[1]).not.toContain(900)
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']))
    await app.close()
  })

  it('POST só com nome e tipo de cliente fica a revisar', async () => {
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] }
      if (text.includes('SELECT id FROM clientes')) return { rows: [{ id: clienteId }] }
      if (text.includes('has_baseline_condition')) return { rows: [] }
      if (text.includes('SELECT id FROM marcas')) return { rows: [] }
      if (text.includes('SELECT id, nome, site')) {
        return { rows: [{ id: clienteId, nome: 'Cliente Novo', status: 'ativo', site: null, logo_url: null }] }
      }
      if (text.includes('INSERT INTO marcas')) return { rows: [{ id: marcaId }] }
      if (text.includes('UPDATE marcas SET')) {
        return {
          rows: [{
            id: marcaId, tipo: 'cliente', nome: 'Cliente Novo',
            valor_fixo_minimo: 0, comissao_franquia_pct: 0,
            comissao_franqueadora_pct: 0, tipo_cobranca: 'fixo_mais_comissao',
          }],
        }
      }
      return { rows: [] }
    })
    const app = buildApp(query)
    await app.register(marcasRoutes)
    const response = await app.inject({
      method: 'POST', url: '/v1/marcas',
      payload: { nome: 'Cliente Novo', tipo: 'cliente', cliente_id: clienteId },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().configuracao_comercial.status).toBe('a_revisar')
    expect(response.json().configuracao_comercial.status).not.toBe('configurado')
    const update = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE marcas SET'))
    expect(update[1]).not.toContain(7)
    await app.close()
  })
})
