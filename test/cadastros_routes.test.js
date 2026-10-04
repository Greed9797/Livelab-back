import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cadastrosRoutes } from '../src/routes/cadastros.js'
import { chaveAlcancaRota } from '../src/plugins/auth.js'
import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'
import { LISTAGEM_NAMESPACES } from '../src/routes/marcas.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const clienteId = '33333333-3333-4333-8333-333333333333'

const linha = {
  id: marcaId, marca_id: marcaId, cliente_id: clienteId, tenant_id: tenantId, nome: 'Rosa', tipo: 'cliente',
  sistema: false, gera_receita: true, status_operacional: 'ativa', status: 'ativa', status_comercial: 'ativo',
  celular: '47999', email: 'rosa@x.com', cnpj: '123', razao_social: 'Rosa LTDA', gateway_customer_id: 'cus_1',
  acesso_user_id: null, acesso_email: null, acesso_ativo: null, apresentadoras: [],
  gmv_mes: '10.5', lives_mes: 1, videos_mes: 0, comercial_condicao_id: null,
}

function buildApp({ papel = 'franqueado', viaApiKey = null, handler } = {}) {
  const app = Fastify()
  const query = vi.fn(async (sql, params) => (await handler?.(sql, params)) ?? { rows: [] })
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel }
    if (viaApiKey) request.viaApiKey = viaApiKey
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query, release: vi.fn() }))
  return { app, query }
}

beforeEach(() => _clearDashboardCache())

describe('GET /v1/cadastros', () => {
  it('lista com tenant explícito e contrato do cadastro', async () => {
    const { app, query } = buildApp({ handler: (sql) => (/FROM marcas m/.test(sql) ? { rows: [linha] } : null) })
    await app.register(cadastrosRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/cadastros?tipo=cliente&gera_receita=true' })
    expect(res.statusCode).toBe(200)
    const [item] = res.json()
    expect(item).toMatchObject({ id: marcaId, marca_id: marcaId, cliente_id: clienteId, gera_receita: true, gmv_mes: 10.5, celular: '47999' })
    expect(item.configuracao_comercial.status).toBe('incompleto')
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('m.tenant_id = $1::uuid')
    expect(params[0]).toBe(tenantId)
    expect(params).toContain('cliente')
  })

  it('chave de API lê o cadastro sem a ficha (contato/faturamento)', async () => {
    const { app } = buildApp({ papel: 'automacao', viaApiKey: { id: 'k' }, handler: (sql) => (/FROM marcas m/.test(sql) ? { rows: [linha] } : null) })
    await app.register(cadastrosRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/cadastros' })
    expect(res.statusCode).toBe(200)
    const [item] = res.json()
    expect(item.celular).toBeNull()
    expect(item.cnpj).toBeNull()
    expect(item.gateway_customer_id).toBeNull()
    expect(item.nome).toBe('Rosa')
  })

  it('papel sem leitura de marcas → 403', async () => {
    const { app } = buildApp({ papel: 'financeiro' })
    await app.register(cadastrosRoutes)
    expect((await app.inject({ method: 'GET', url: '/v1/cadastros' })).statusCode).toBe(403)
  })
})

describe('GET /v1/cadastros/:id', () => {
  it('404 com código estável', async () => {
    const { app } = buildApp()
    await app.register(cadastrosRoutes)
    const res = await app.inject({ method: 'GET', url: `/v1/cadastros/${marcaId}` })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('CADASTRO_NAO_ENCONTRADO')
  })

  it('aceita cliente_id e devolve o cadastro da marca', async () => {
    const { app } = buildApp({
      handler: (sql) => {
        if (/SELECT id FROM marcas WHERE id/.test(sql)) return { rows: [] }
        if (/JOIN clientes c ON c.id = m.cliente_id/.test(sql) && /LIMIT 1/.test(sql)) return { rows: [{ id: marcaId }] }
        if (/FROM marcas m/.test(sql)) return { rows: [linha] }
        return null
      },
    })
    await app.register(cadastrosRoutes)
    const res = await app.inject({ method: 'GET', url: `/v1/cadastros/${clienteId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().marca_id).toBe(marcaId)
  })
})

describe('escritas', () => {
  it('chave de API não escreve (papel) e a allowlist só tem os GET', async () => {
    const { app } = buildApp({ papel: 'automacao', viaApiKey: { id: 'k' } })
    await app.register(cadastrosRoutes)
    expect((await app.inject({ method: 'POST', url: '/v1/cadastros', payload: { nome: 'X' } })).statusCode).toBe(403)
    expect(chaveAlcancaRota('GET', '/v1/cadastros')).toBe(true)
    expect(chaveAlcancaRota('GET', `/v1/cadastros/${marcaId}`)).toBe(true)
    expect(chaveAlcancaRota('POST', '/v1/cadastros')).toBe(false)
    expect(chaveAlcancaRota('PATCH', `/v1/cadastros/${marcaId}`)).toBe(false)
    expect(chaveAlcancaRota('POST', `/v1/cadastros/${marcaId}/promover-cliente`)).toBe(false)
    expect(chaveAlcancaRota('GET', '/v1/cadastros', 'automacao_financeiro')).toBe(false)
  })

  it('erro de regra vira 4xx com code (não 500)', async () => {
    const { app } = buildApp()
    await app.register(cadastrosRoutes)
    const res = await app.inject({ method: 'PATCH', url: `/v1/cadastros/${marcaId}`, payload: { tipo: 'afiliada' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'USE_PROMOVER_CLIENTE' })
    const fin = await app.inject({ method: 'POST', url: '/v1/cadastros', payload: { nome: 'X', valor_fixo_minimo: 10 } })
    expect(fin.statusCode).toBe(409)
    expect(fin.json()).toMatchObject({ code: 'USE_MARCA_CONDITION_ENDPOINT', campos: ['valor_fixo_minimo'] })
  })

  it('a listagem de cadastros entra na invalidação de marca/cliente', () => {
    expect(LISTAGEM_NAMESPACES).toEqual(expect.arrayContaining(['marcas:list', 'clientes:list', 'cadastros:list']))
  })
})
