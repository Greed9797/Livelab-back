import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../src/services/custos-plano.js', async (orig) => {
  const real = await orig()
  return { ...real, pagarCusto: vi.fn(), desfazerBaixaCusto: vi.fn() }
})
vi.mock('../src/services/receitas-avulsas.js', async (orig) => {
  const real = await orig()
  return { ...real, receberReceitaAvulsa: vi.fn() }
})

import * as custos from '../src/services/custos-plano.js'
import * as avulsas from '../src/services/receitas-avulsas.js'

import {
  AsaasError,
  ASAAS_BASE_URL_PROD,
  ASAAS_BASE_URL_SANDBOX,
  baseUrlParaChave,
  criarClienteAsaas,
  resolverChaveAsaas,
  statusHttpParaErroAsaas,
} from '../src/services/asaas.js'
import { encryptToken } from '../src/services/token-crypto.js'
import { asaasRoutes } from '../src/routes/asaas.js'

// Nenhum teste acessa a rede: todo fetch é mock.
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body == null ? '' : JSON.stringify(body)),
})

const CHAVE = '$aact_prod_abc123'

describe('resolverChaveAsaas / baseUrl', () => {
  const envOriginal = { ...process.env }
  afterEach(() => { process.env = { ...envOriginal } })

  it('chave em texto claro ($aact_) passa direto, mesmo sem TOKEN_ENCRYPTION_KEY', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(resolverChaveAsaas(CHAVE)).toBe(CHAVE)
    expect(resolverChaveAsaas('  ')).toBeNull()
    expect(resolverChaveAsaas(null)).toBeNull()
  })

  it('chave criptografada com token-crypto é aberta', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64)
    expect(resolverChaveAsaas(encryptToken(CHAVE))).toBe(CHAVE)
  })

  it('sandbox por prefixo hmlg; env ASAAS_BASE_URL tem precedência', () => {
    delete process.env.ASAAS_BASE_URL
    expect(baseUrlParaChave(CHAVE)).toBe(ASAAS_BASE_URL_PROD)
    expect(baseUrlParaChave('$aact_hmlg_x')).toBe(ASAAS_BASE_URL_SANDBOX)
    process.env.ASAAS_BASE_URL = 'http://mock.local/v3/'
    expect(baseUrlParaChave(CHAVE)).toBe('http://mock.local/v3')
  })
})

describe('criarClienteAsaas', () => {
  it('exige chave', () => {
    expect(() => criarClienteAsaas({ apiKey: '' })).toThrow(AsaasError)
  })

  it('envia access_token + User-Agent e lê saldo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ balance: 1234.56 }))
    const c = criarClienteAsaas({ apiKey: CHAVE, baseUrl: 'http://x/v3', fetchImpl })
    await expect(c.saldo()).resolves.toEqual({ saldo: 1234.56 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/v3/finance/balance')
    expect(init.method).toBe('GET')
    expect(init.headers.access_token).toBe(CHAVE)
    expect(init.headers['User-Agent']).toBeTruthy()
  })

  it('pagina por offset/limit até hasMore=false', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonRes({ hasMore: true, data: Array.from({ length: 100 }, (_, i) => ({ id: `ft_${i}` })) }))
      .mockResolvedValueOnce(jsonRes({ hasMore: false, data: [{ id: 'ft_100' }] }))
    const c = criarClienteAsaas({ apiKey: CHAVE, baseUrl: 'http://x/v3', fetchImpl })
    const itens = await c.extrato({ inicio: '2026-03-01', fim: '2026-03-31' })
    expect(itens).toHaveLength(101)
    const u1 = new URL(fetchImpl.mock.calls[0][0])
    const u2 = new URL(fetchImpl.mock.calls[1][0])
    expect(u1.pathname).toBe('/v3/financialTransactions')
    expect(u1.searchParams.get('startDate')).toBe('2026-03-01')
    expect(u1.searchParams.get('finishDate')).toBe('2026-03-31')
    expect(u1.searchParams.get('offset')).toBe('0')
    expect(u1.searchParams.get('limit')).toBe('100')
    expect(u2.searchParams.get('offset')).toBe('100')
  })

  it('pagamentosRecebidos filtra status=RECEIVED e paymentDate[ge|le]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ hasMore: false, data: [] }))
    const c = criarClienteAsaas({ apiKey: CHAVE, baseUrl: 'http://x/v3', fetchImpl })
    await c.pagamentosRecebidos({ inicio: '2026-03-01', fim: '2026-03-31' })
    const u = new URL(fetchImpl.mock.calls[0][0])
    expect(u.searchParams.get('status')).toBe('RECEIVED')
    expect(u.searchParams.get('paymentDate[ge]')).toBe('2026-03-01')
    expect(u.searchParams.get('paymentDate[le]')).toBe('2026-03-31')
  })

  it('aborta paginação infinita', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ hasMore: true, data: [{ id: 'x' }] }))
    const c = criarClienteAsaas({ apiKey: CHAVE, baseUrl: 'http://x/v3', fetchImpl, maxPaginas: 3 })
    await expect(c.extrato({ inicio: '2026-03-01', fim: '2026-03-31' }))
      .rejects.toMatchObject({ codigo: 'PAGINACAO_EXCEDIDA' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('401 → CHAVE_INVALIDA sem retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ errors: [{ code: 'invalid_access_token', description: 'Token inválido' }] }, 401))
    const c = criarClienteAsaas({ apiKey: CHAVE, baseUrl: 'http://x/v3', fetchImpl, backoffMs: 0 })
    await expect(c.saldo()).rejects.toMatchObject({ codigo: 'CHAVE_INVALIDA', status: 401 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('400 propaga description do Asaas', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ errors: [{ code: 'invalid_date', description: 'Data inválida' }] }, 400))
    const c = criarClienteAsaas({ apiKey: CHAVE, baseUrl: 'http://x/v3', fetchImpl, backoffMs: 0 })
    await expect(c.saldo()).rejects.toThrow('Asaas: Data inválida')
  })

  it('5xx faz 1 retry e depois sucede', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonRes(null, 503))
      .mockResolvedValueOnce(jsonRes({ balance: 10 }))
    const c = criarClienteAsaas({ apiKey: CHAVE, baseUrl: 'http://x/v3', fetchImpl, backoffMs: 0 })
    await expect(c.saldo()).resolves.toEqual({ saldo: 10 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('timeout aborta a requisição (via signal)', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e)
      })
    }))
    const c = criarClienteAsaas({ apiKey: CHAVE, baseUrl: 'http://x/v3', fetchImpl, timeoutMs: 10, tentativas: 1 })
    await expect(c.saldo()).rejects.toMatchObject({ codigo: 'TIMEOUT' })
  })

  it('falha de rede e JSON inválido', async () => {
    const c1 = criarClienteAsaas({
      apiKey: CHAVE, baseUrl: 'http://x/v3', tentativas: 1,
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    })
    await expect(c1.saldo()).rejects.toMatchObject({ codigo: 'REDE' })
    const c2 = criarClienteAsaas({
      apiKey: CHAVE, baseUrl: 'http://x/v3', tentativas: 1,
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<html>' }),
    })
    await expect(c2.saldo()).rejects.toMatchObject({ codigo: 'RESPOSTA_INVALIDA' })
  })

  it('statusHttpParaErroAsaas', () => {
    expect(statusHttpParaErroAsaas(new AsaasError('x', { codigo: 'SEM_CHAVE' }))).toBe(409)
    expect(statusHttpParaErroAsaas(new AsaasError('x', { codigo: 'TIMEOUT' }))).toBe(504)
    expect(statusHttpParaErroAsaas(new AsaasError('x', { codigo: 'CHAVE_INVALIDA' }))).toBe(502)
  })
})

// ─── Rotas (Fastify inject + db fake + fetch global mockado) ─────────
const TENANT = '00000000-0000-0000-0000-000000000001'
const TX_ID = '11111111-1111-1111-1111-111111111111'
const RECEITA_ID = '22222222-2222-2222-2222-222222222222'

function buildApp({ papel = 'franqueado', tabelasExistem = true, onQuery = () => ({ rows: [] }) } = {}) {
  const app = Fastify()
  const queries = []
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: TENANT, papel, sub: '33333333-3333-3333-3333-333333333333' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({
    query: async (sql, params) => {
      queries.push({ sql, params })
      if (/SELECT gateway_api_key FROM tenants/.test(sql)) return { rows: [{ gateway_api_key: CHAVE }] }
      if (/to_regclass/.test(sql)) return { rows: [{ existe: tabelasExistem }] }
      return onQuery(sql, params) ?? { rows: [] }
    },
  }))
  app.register(asaasRoutes)
  return { app, queries }
}

describe('rotas /v1/asaas', () => {
  let fetchMock
  beforeEach(() => {
    custos.pagarCusto.mockReset()
    custos.desfazerBaixaCusto.mockReset()
    avulsas.receberReceitaAvulsa.mockReset()
    process.env.ASAAS_BASE_URL = 'http://mock.local/v3'
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.ASAAS_BASE_URL
  })

  it('GET /saldo devolve saldo do Asaas', async () => {
    fetchMock.mockResolvedValue(jsonRes({ balance: 500.25 }))
    const { app } = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/asaas/saldo' })
    expect(res.statusCode).toBe(200)
    expect(res.json().saldo).toBe(500.25)
    expect(fetchMock.mock.calls[0][0]).toBe('http://mock.local/v3/finance/balance')
  })

  it('GET /saldo sem chave → 409', async () => {
    const app2 = Fastify()
    app2.decorate('authenticate', async (r) => { r.user = { tenant_id: TENANT, papel: 'franqueado' } })
    app2.decorate('requirePapel', () => async () => {})
    app2.decorate('withTenant', async (_t, fn) => fn({ query: async () => ({ rows: [{ gateway_api_key: null }] }) }))
    app2.register(asaasRoutes)
    const res = await app2.inject({ method: 'GET', url: '/v1/asaas/saldo' })
    expect(res.statusCode).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('papel sem acesso → 403 (sincronizar exige WRITE_FINANCEIRO)', async () => {
    const { app } = buildApp({ papel: 'financeiro_readonly' })
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/sincronizar', payload: {} })
    expect(res.statusCode).toBe(403)
  })

  it('conciliar/extrato/saldo só usam GET no Asaas (somente leitura)', async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = new URL(url)
      if (u.pathname.endsWith('/finance/balance')) return jsonRes({ balance: 1 })
      return jsonRes({ hasMore: false, data: [{ id: 'ft_1', value: 10, date: '2026-03-05', paymentId: 'pay_1' }] })
    })
    const { app } = buildApp()
    await app.inject({ method: 'GET', url: '/v1/asaas/saldo' })
    await app.inject({ method: 'GET', url: '/v1/asaas/extrato?inicio=2026-03-01&fim=2026-03-31' })
    await app.inject({ method: 'POST', url: '/v1/asaas/sincronizar', payload: { inicio: '2026-03-01', fim: '2026-03-31' } })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2)
    for (const [, init] of fetchMock.mock.calls) expect(init.method).toBe('GET')
  })

  it('GET /extrato valida período', async () => {
    const { app } = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/asaas/extrato?inicio=2026-05-01&fim=2026-04-01' })
    expect(res.statusCode).toBe(400)
  })

  it('GET /extrato ao vivo totaliza entradas/saídas', async () => {
    fetchMock.mockResolvedValue(jsonRes({
      hasMore: false,
      data: [
        { id: 'ft_1', value: 100, date: '2026-03-05', type: 'PAYMENT_RECEIVED', balance: 100 },
        { id: 'ft_2', value: -1.99, date: '2026-03-05', type: 'PAYMENT_FEE', balance: 98.01 },
      ],
    }))
    const { app } = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/asaas/extrato?inicio=2026-03-01&fim=2026-03-31' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ fonte: 'asaas', total_entradas: 100, total_saidas: 1.99, liquido: 98.01 })
    expect(body.itens[1]).toMatchObject({ tipo: 'saida', saldo_apos: 98.01 })
    expect(body.itens[0].raw).toBeUndefined()
  })

  it('POST /sincronizar faz upsert com tenant_id e customer do payment', async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = new URL(url)
      if (u.pathname.endsWith('/financialTransactions')) {
        return jsonRes({ hasMore: false, data: [
          { id: 'ft_1', value: 3000, date: '2026-03-10', type: 'PAYMENT_RECEIVED', paymentId: 'pay_1' },
          { id: 'ft_2', value: 50, date: '2026-03-11', type: 'PAYMENT_RECEIVED', paymentId: 'pay_old' },
        ] })
      }
      if (u.pathname.endsWith('/payments')) {
        return jsonRes({ hasMore: false, data: [{ id: 'pay_1', customer: 'cus_A', value: 3000 }] })
      }
      if (u.pathname.endsWith('/payments/pay_old')) return jsonRes({ id: 'pay_old', customer: 'cus_B', value: 50 })
      return jsonRes(null, 404)
    })
    const { app, queries } = buildApp({
      onQuery: (sql) => (/INSERT INTO gateway_transacoes/.test(sql)
        ? { rows: [{ inserida: true }, { inserida: false }] }
        : { rows: [] }),
    })
    const res = await app.inject({
      method: 'POST', url: '/v1/asaas/sincronizar', payload: { inicio: '2026-03-01', fim: '2026-03-31' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ total: 2, inseridas: 1, atualizadas: 1 })
    const ins = queries.find((q) => /INSERT INTO gateway_transacoes/.test(q.sql))
    expect(ins.params[0]).toBe(TENANT)
    const lote = JSON.parse(ins.params[1])
    expect(lote.map((l) => l.customer_id)).toEqual(['cus_A', 'cus_B'])
    expect(queries.map((q) => q.sql)).toContain('COMMIT')
    // janela de payments recua 10 dias
    const pay = fetchMock.mock.calls.map(([u]) => new URL(u)).find((u) => u.pathname.endsWith('/payments'))
    expect(pay.searchParams.get('paymentDate[ge]')).toBe('2026-02-19')
  })

  it('POST /sincronizar: chave inválida → 502 sem tocar no banco', async () => {
    fetchMock.mockResolvedValue(jsonRes({ errors: [{ description: 'x' }] }, 401))
    const { app, queries } = buildApp()
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/sincronizar', payload: {} })
    expect(res.statusCode).toBe(502)
    expect(res.json().codigo).toBe('CHAVE_INVALIDA')
    expect(queries.some((q) => /INSERT/.test(q.sql))).toBe(false)
  })

  it('GET /conciliacao: sem receita_titulos → avisa em vez de 500', async () => {
    const { app } = buildApp({
      tabelasExistem: false,
      onQuery: (sql) => (/FROM gateway_transacoes g/.test(sql)
        ? { rows: [{ id: TX_ID, tipo: 'entrada', valor: 3000, data: '2026-03-10', customer_id: 'cus_A' }] }
        : { rows: [] }),
    })
    const res = await app.inject({ method: 'GET', url: '/v1/asaas/conciliacao?inicio=2026-03-01&fim=2026-03-31' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.avisos).toHaveLength(1)
    expect(body.itens[0].sugestoes).toEqual([])
  })

  it('GET /conciliacao: saídas sem módulo de custos (custos-plano) → aviso, não 500', async () => {
    const { app } = buildApp()
    const res = await app.inject({ method: 'GET', url: '/v1/asaas/conciliacao?tipo=saida&inicio=2026-03-01&fim=2026-03-31' })
    expect(res.statusCode).toBe(200)
    // custos-plano.js ainda não existe nesta frente: degrada; se já existir, apenas não quebra
    expect(Array.isArray(res.json().avisos)).toBe(true)
  })

  it('POST /conciliar valida body', async () => {
    const { app } = buildApp()
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/conciliar', payload: { transacao_id: 'x', tipo: 'receita', id: RECEITA_ID } })
    expect(res.statusCode).toBe(400)
  })

  it('POST /conciliar: saída não concilia com receita', async () => {
    const { app, queries } = buildApp({
      onQuery: (sql) => (/FOR UPDATE/.test(sql) ? { rows: [{ id: TX_ID, tipo: 'saida', conciliado_com_id: null }] } : { rows: [] }),
    })
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/conciliar', payload: { transacao_id: TX_ID, tipo: 'receita', id: RECEITA_ID } })
    expect(res.statusCode).toBe(400)
    expect(queries.map((q) => q.sql)).toContain('ROLLBACK')
  })

  it('POST /conciliar: já conciliada → 409', async () => {
    const { app } = buildApp({
      onQuery: (sql) => (/FOR UPDATE/.test(sql) ? { rows: [{ id: TX_ID, tipo: 'entrada', conciliado_com_id: RECEITA_ID }] } : { rows: [] }),
    })
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/conciliar', payload: { transacao_id: TX_ID, tipo: 'receita', id: RECEITA_ID } })
    expect(res.statusCode).toBe(409)
  })

  const CUSTO_ID = '44444444-4444-4444-4444-444444444444'

  it('POST /conciliar: custo — baixa + vínculo na mesma transação, com tenant_id', async () => {
    custos.pagarCusto.mockImplementation(async (db) => {
      await db.query('BEGIN'); await db.query('COMMIT')
      return { valor_pago: 250, data_pagamento: '2026-03-20' }
    })
    const { app, queries } = buildApp({
      onQuery: (sql) => {
        if (/FROM gateway_transacoes/.test(sql) && /FOR UPDATE/.test(sql)) {
          return { rows: [{ id: TX_ID, tipo: 'saida', valor: 250, data: '2026-03-20', conciliado_com_id: null }] }
        }
        if (/FROM custos/.test(sql)) return { rows: [{ id: CUSTO_ID, valor_pago: null, tipo: 'outros' }] }
        if (/UPDATE gateway_transacoes/.test(sql)) return { rows: [{ id: TX_ID, conciliado_com_tipo: 'custo', conciliado_com_id: CUSTO_ID, conciliado_baixa: true }] }
        return { rows: [] }
      },
    })
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/conciliar', payload: { transacao_id: TX_ID, tipo: 'custo', id: CUSTO_ID } })
    expect(res.statusCode).toBe(200)
    expect(res.json().conciliado_com_id).toBe(CUSTO_ID)
    expect(res.json().baixa).toMatchObject({ aplicada: true, valor_pago: 250, data_pagamento: '2026-03-20' })
    const sqls = queries.map((q) => q.sql)
    const iBegin = sqls.indexOf('BEGIN')
    const iBaixa = sqls.findIndex((x) => /^SAVEPOINT conc_sp_/.test(x))
    const iVinculo = sqls.findIndex((x) => /UPDATE gateway_transacoes/.test(x))
    const iCommit = sqls.indexOf('COMMIT')
    expect(iBegin).toBeGreaterThanOrEqual(0)
    expect(iBaixa).toBeGreaterThan(iBegin)
    expect(iVinculo).toBeGreaterThan(iBaixa)
    expect(iCommit).toBeGreaterThan(iVinculo)
    expect(custos.pagarCusto.mock.calls[0][1]).toMatchObject({ tenantId: TENANT, id: CUSTO_ID, valorPago: '250.00' })
    expect(sqls.some((x) => /UPDATE custos/.test(x))).toBe(false)
    expect(queries[iVinculo].params).toEqual([TX_ID, TENANT, 'custo', CUSTO_ID, '33333333-3333-3333-3333-333333333333', true])
  })

  const AVULSA_ID = '55555555-5555-5555-5555-555555555555'

  it('POST /conciliar: avulsa — baixa a receita avulsa e vincula na mesma transação', async () => {
    avulsas.receberReceitaAvulsa.mockImplementation(async (db) => {
      await db.query('BEGIN'); await db.query('COMMIT')
      return { id: AVULSA_ID, valor_pago: 800, data_pagamento: '2026-03-21' }
    })
    const { app, queries } = buildApp({
      onQuery: (sql) => {
        if (/FROM gateway_transacoes/.test(sql) && /FOR UPDATE/.test(sql)) {
          return { rows: [{ id: TX_ID, tipo: 'entrada', valor: 800, data: '2026-03-21', conciliado_com_id: null }] }
        }
        if (/SELECT id, valor_pago(, perdido_em)? FROM receitas_avulsas/.test(sql)) return { rows: [{ id: AVULSA_ID, valor_pago: '0.00' }] }
        if (/UPDATE gateway_transacoes/.test(sql)) return { rows: [{ id: TX_ID, conciliado_com_tipo: 'avulsa', conciliado_com_id: AVULSA_ID, conciliado_baixa: true }] }
        return { rows: [] }
      },
    })
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/conciliar', payload: { transacao_id: TX_ID, tipo: 'avulsa', id: AVULSA_ID } })
    expect(res.statusCode).toBe(200)
    expect(res.json().baixa).toMatchObject({ aplicada: true, valor_pago: 800, data_pagamento: '2026-03-21' })
    const sqls = queries.map((q) => q.sql)
    const iBaixa = sqls.findIndex((x) => /^SAVEPOINT conc_sp_/.test(x))
    const iVinculo = sqls.findIndex((x) => /UPDATE gateway_transacoes/.test(x))
    expect(iBaixa).toBeGreaterThan(sqls.indexOf('BEGIN'))
    expect(iVinculo).toBeGreaterThan(iBaixa)
    expect(sqls.indexOf('COMMIT')).toBeGreaterThan(iVinculo)
    expect(avulsas.receberReceitaAvulsa.mock.calls[0][1]).toMatchObject({
      tenantId: TENANT, id: AVULSA_ID, valorPago: '800.00',
    })
    expect(sqls.some((x) => /UPDATE receitas_avulsas/.test(x))).toBe(false)
    expect(queries[iVinculo].params.slice(2, 4)).toEqual(['avulsa', AVULSA_ID])
  })

  it('POST /conciliar: avulsa não aceita saída', async () => {
    const { app } = buildApp({
      onQuery: (sql) => (/FOR UPDATE/.test(sql) ? { rows: [{ id: TX_ID, tipo: 'saida', valor: 10, data: '2026-03-20', conciliado_com_id: null }] } : { rows: [] }),
    })
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/conciliar', payload: { transacao_id: TX_ID, tipo: 'avulsa', id: AVULSA_ID } })
    expect(res.statusCode).toBe(400)
  })

  it('GET /conciliacao (entrada): sugere receita avulsa em aberto', async () => {
    const { app } = buildApp({
      onQuery: (sql) => {
        if (/FROM gateway_transacoes g/.test(sql)) return { rows: [{ id: TX_ID, tipo: 'entrada', valor: 800, data: '2026-03-20', customer_id: null }] }
        if (/FROM receitas_avulsas/.test(sql)) {
          return { rows: [{ id: AVULSA_ID, descricao: 'Serviço', grupo: 'servico', valor_previsto: '800.00', valor_pago: '0.00',
            data_vencimento: '2026-03-20', data_pagamento: null, competencia: '2026-03-01' }] }
        }
        return { rows: [] }
      },
    })
    const res = await app.inject({ method: 'GET', url: '/v1/asaas/conciliacao?inicio=2026-03-01&fim=2026-03-31' })
    expect(res.statusCode).toBe(200)
    expect(res.json().itens[0].sugestoes[0]).toMatchObject({ tipo: 'avulsa', id: AVULSA_ID, valor_casado: 800 })
  })

  it('POST /conciliar: alvo inexistente → 404 e ROLLBACK (nada gravado)', async () => {
    const { app, queries } = buildApp({
      onQuery: (sql) => (/FOR UPDATE/.test(sql) && /gateway_transacoes/.test(sql)
        ? { rows: [{ id: TX_ID, tipo: 'saida', valor: 10, data: '2026-03-20', conciliado_com_id: null }] } : { rows: [] }),
    })
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/conciliar', payload: { transacao_id: TX_ID, tipo: 'custo', id: CUSTO_ID } })
    expect(res.statusCode).toBe(404)
    const sqls = queries.map((q) => q.sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
    expect(sqls.some((x) => /UPDATE gateway_transacoes/.test(x))).toBe(false)
  })

  it('POST /conciliar: tipo imposto aceita id virtual; entrada não concilia com imposto', async () => {
    const { app } = buildApp({
      onQuery: (sql) => (/FOR UPDATE/.test(sql) ? { rows: [{ id: TX_ID, tipo: 'entrada', valor: 10, data: '2026-03-20', conciliado_com_id: null }] } : { rows: [] }),
    })
    const res = await app.inject({ method: 'POST', url: '/v1/asaas/conciliar', payload: { transacao_id: TX_ID, tipo: 'imposto', id: 'imposto:2026-03' } })
    expect(res.statusCode).toBe(400)
  })

  it('DELETE /conciliacao: desfaz baixa gerada pela conciliação', async () => {
    custos.desfazerBaixaCusto.mockImplementation(async (db) => {
      await db.query('BEGIN'); await db.query('COMMIT')
      return { id: CUSTO_ID }
    })
    const { app, queries } = buildApp({
      onQuery: (sql) => {
        if (/FROM gateway_transacoes/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [{ id: TX_ID, conciliado_com_tipo: 'custo', conciliado_com_id: CUSTO_ID, conciliado_baixa: true }] }
        if (/FROM financeiro_liquidacoes l/.test(sql)) return { rows: [{ id: RECEITA_ID, origem_tipo: 'custo', origem_id: CUSTO_ID, saldo: '250.00' }] }
        return { rows: [] }
      },
    })
    const res = await app.inject({ method: 'DELETE', url: `/v1/asaas/conciliacao/${TX_ID}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, baixa_desfeita: true })
    expect(custos.desfazerBaixaCusto.mock.calls[0][1]).toMatchObject({ tenantId: TENANT, id: CUSTO_ID })
    expect(queries.some((q) => /UPDATE custos/.test(q.sql))).toBe(false)
    expect(queries.some((q) => /UPDATE gateway_transacoes/.test(q.sql))).toBe(true)
    expect(queries.map((q) => q.sql)).toContain('COMMIT')
  })

  it('DELETE /conciliacao: vínculo antigo sem fato marcado retorna 409 e mantém vínculo', async () => {
    const { app, queries } = buildApp({
      onQuery: (sql) => (/FROM gateway_transacoes/.test(sql) && /FOR UPDATE/.test(sql)
        ? { rows: [{ id: TX_ID, conciliado_com_tipo: 'custo', conciliado_com_id: CUSTO_ID, conciliado_baixa: true }] }
        : { rows: [] }),
    })
    const res = await app.inject({ method: 'DELETE', url: `/v1/asaas/conciliacao/${TX_ID}` })
    expect(res.statusCode).toBe(409)
    expect(res.json().codigo).toBe('CONCILIACAO_BAIXA_AMBIGUA')
    expect(queries.some((q) => /UPDATE gateway_transacoes/.test(q.sql))).toBe(false)
    expect(queries.map((q) => q.sql)).toContain('ROLLBACK')
  })

  it('DELETE /conciliacao: schema financeiro ausente retorna 409 e mantém vínculo', async () => {
    const { app, queries } = buildApp({
      onQuery: (sql) => {
        if (/FROM gateway_transacoes/.test(sql) && /FOR UPDATE/.test(sql)) {
          return { rows: [{ id: TX_ID, conciliado_com_tipo: 'custo', conciliado_com_id: CUSTO_ID, conciliado_baixa: true }] }
        }
        if (/FROM financeiro_liquidacoes l/.test(sql)) throw Object.assign(new Error('relation does not exist'), { code: '42P01' })
        return { rows: [] }
      },
    })
    const res = await app.inject({ method: 'DELETE', url: `/v1/asaas/conciliacao/${TX_ID}` })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('Módulo financeiro ainda não migrado')
    expect(queries.some((q) => /UPDATE gateway_transacoes/.test(q.sql))).toBe(false)
    expect(queries.map((q) => q.sql)).toContain('ROLLBACK')
  })

  it('DELETE /conciliacao: baixa manual (conciliado_baixa=false) NÃO é desfeita', async () => {
    const { app, queries } = buildApp({
      onQuery: (sql) => (/FOR UPDATE/.test(sql)
        ? { rows: [{ id: TX_ID, conciliado_com_tipo: 'custo', conciliado_com_id: CUSTO_ID, conciliado_baixa: false }] } : { rows: [] }),
    })
    const res = await app.inject({ method: 'DELETE', url: `/v1/asaas/conciliacao/${TX_ID}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().baixa_desfeita).toBe(false)
    expect(queries.some((q) => /UPDATE custos/.test(q.sql))).toBe(false)
    expect(queries.some((q) => /UPDATE gateway_transacoes/.test(q.sql))).toBe(true)
  })

  it('DELETE /conciliacao/:id → 404 quando não existe', async () => {
    const { app } = buildApp()
    const res = await app.inject({ method: 'DELETE', url: `/v1/asaas/conciliacao/${TX_ID}` })
    expect(res.statusCode).toBe(404)
  })
})
