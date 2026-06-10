/**
 * Testes da Fase 8 — Relatório PDF
 *
 * Cobre:
 *  1. gerarRelatorioOperacionalPdf — gerador puro com dados completos
 *  2. gerarRelatorioOperacionalPdf — dados com nulls (clicks, comissão apr., pct_meta)
 *  3. GET /v1/cliente/relatorio.pdf — rota 200 + content-type + filename
 *  4. GET /v1/cliente/relatorio.pdf — 403 papel errado
 */

import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { gerarRelatorioOperacionalPdf } from '../src/services/relatorio_pdf.js'
import { clienteDashboardRoutes } from '../src/routes/cliente_dashboard.js'

// ---------------------------------------------------------------------------
// Helpers de setup — mesma convenção dos outros testes do repo
// ---------------------------------------------------------------------------

function buildApp({ papel = 'cliente_parceiro', userId = 'user-1', tenantId = 'tenant-1' } = {}) {
  const app = Fastify({ logger: false })
  const releaseMock = vi.fn()
  let queryMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { sub: userId, tenant_id: tenantId, papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { sub: userId, tenant_id: tenantId, papel }
    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Acesso não autorizado' })
    }
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))

  return { app, queryMock, releaseMock, setQueryMock: (fn) => { queryMock = fn } }
}

function seqMock(responses) {
  let i = 0
  return vi.fn().mockImplementation(() => {
    const r = responses[i] ?? { rows: [] }
    i++
    return Promise.resolve(r)
  })
}

// ---------------------------------------------------------------------------
// Fixtures reutilizáveis
// ---------------------------------------------------------------------------

const USER_ROW    = { rows: [{ email: 'parceiro@test.com' }] }
const CLIENTE_ROW = { rows: [{ id: 'cli-1', nome: 'Marca Teste', nicho: 'Moda' }] }
const CONFIG_COMPLETA = { rows: [{ meta_gmv_hora: '500', margem_pct: '15' }] }
const CONTRATO_ATIVO  = {
  rows: [{
    id:                'ctr-1',
    comissao_pct:      '10',
    valor_fixo:        '2400',
    horas_contratadas: '12',
    pacote_valor:      null,
    horas_incluidas:   null,
  }],
}

// Métricas consolidadas — todos os campos preenchidos
const METRICS_COMPLETO = {
  rows: [{
    horas_live:                  '4.0000',
    gmv:                         '2400',
    comissao_livelab_total:      '240',
    comissao_apresentadora_total:'48',
    views:                       '5000',
    clicks:                      '450',
    pedidos:                     '40',
    primeiro_problema:           null,
  }],
}

// Métricas com nulls (clicks não medido, comissão apr. nula)
const METRICS_NULLS = {
  rows: [{
    horas_live:                  '2.0000',
    gmv:                         '1000',
    comissao_livelab_total:      '100',
    comissao_apresentadora_total: null,
    views:                       '2000',
    clicks:                      null,
    pedidos:                     '15',
    primeiro_problema:           null,
  }],
}

// Sessão completa
const SESSAO_ROW = {
  id:                            'live-1',
  iniciado_em:                   '2026-06-07T22:00:00.000Z',
  encerrado_em:                  '2026-06-08T01:10:00.000Z',
  status:                        'encerrada',
  fat_gerado:                    '1580',
  comissao_calculada:            '158',
  comissao_apresentadora_valor:  '31.6',
  comissao_apresentadora_pct:    '2',
  clicks:                        '200',
  status_operacional:            'ok',
  problema:                      null,
  proxima_acao:                  null,
  final_peak_viewers:            '8200',
  final_orders_count:            '42',
  apresentadora_nome:            'Maria',
  total_count:                   '1',
}

// ---------------------------------------------------------------------------
// Dados mínimos para o gerador puro
// ---------------------------------------------------------------------------

const OPERACIONAL_COMPLETO = {
  periodo: { mes: 6, ano: 2026 },
  config: {
    meta_gmv_hora:        500,
    margem_pct:           15,
    comissao_livelab_pct: 10,
  },
  metricas: {
    horas_live:                   4,
    gmv:                          2400,
    gmv_por_hora:                 600,
    pct_meta_hora:                120,
    comissao_livelab_total:       240,
    comissao_apresentadora_total: 48,
    comissao_por_hora:            60,
    funil: { views: 5000, clicks: 450, pedidos: 40 },
  },
  status: {
    status:       'ok',
    motivos:      [],
    diagnostico:  null,
    proxima_acao: null,
  },
}

const SESSOES_COMPLETO = {
  sessoes: [{
    live_id:                    'live-1',
    data:                       '2026-06-07',
    inicio:                     '2026-06-07T22:00:00.000Z',
    fim:                        '2026-06-08T01:10:00.000Z',
    apresentadora:              'Maria',
    horas:                      3.17,
    gmv:                        1580,
    pedidos:                    42,
    views:                      8200,
    clicks:                     200,
    gmv_por_hora:               498.43,
    pedidos_por_hora:           13.25,
    comissao_livelab:           158,
    comissao_apresentadora:     31.6,
    comissao_apresentadora_pct: 2,
    fim_de_semana:              true,
    status_operacional:         'ok',
    motivos:                    [],
    diagnostico:                null,
    problema:                   null,
    proxima_acao:               null,
  }],
}

// ---------------------------------------------------------------------------
// Testes do gerador puro
// ---------------------------------------------------------------------------

describe('gerarRelatorioOperacionalPdf — gerador puro', () => {
  afterEach(() => vi.restoreAllMocks())

  it('retorna Buffer com cabeçalho %PDF e tamanho > 1kb (dados completos)', async () => {
    const buf = await gerarRelatorioOperacionalPdf({
      cliente:     { nome: 'Marca Teste' },
      periodo:     { mes: 6, ano: 2026 },
      operacional: OPERACIONAL_COMPLETO,
      sessoes:     SESSOES_COMPLETO,
    })

    expect(Buffer.isBuffer(buf)).toBe(true)
    // PDF header
    expect(buf.slice(0, 5).toString()).toBe('%PDF-')
    // Tamanho razoável
    expect(buf.length).toBeGreaterThan(1024)
  })

  it('não lança com clicks null, comissão apresentadora null e pct_meta null', async () => {
    const operacionalNulls = {
      ...OPERACIONAL_COMPLETO,
      metricas: {
        ...OPERACIONAL_COMPLETO.metricas,
        gmv_por_hora:                 null,
        pct_meta_hora:                null,
        comissao_apresentadora_total: null,
        funil: { views: 2000, clicks: null, pedidos: 15 },
      },
      config: {
        meta_gmv_hora:        500,
        margem_pct:           null,
        comissao_livelab_pct: null,
      },
      status: {
        status:       'dados_incompletos',
        motivos:      ['margem não configurada', 'comissão LiveLab não configurada'],
        diagnostico:  null,
        proxima_acao: null,
      },
    }

    const sessoesNulls = {
      sessoes: [{
        ...SESSOES_COMPLETO.sessoes[0],
        clicks:                     null,
        comissao_apresentadora:     null,
        comissao_apresentadora_pct: null,
        gmv_por_hora:               null,
        status_operacional:         'dados_incompletos',
      }],
    }

    await expect(
      gerarRelatorioOperacionalPdf({
        cliente:     { nome: 'Loja Nulls' },
        periodo:     { mes: 3, ano: 2026 },
        operacional: operacionalNulls,
        sessoes:     sessoesNulls,
      }),
    ).resolves.toSatisfy((buf) => Buffer.isBuffer(buf) && buf.length > 1024)
  })

  it('sessoes vazias não lança e ainda gera PDF válido', async () => {
    const buf = await gerarRelatorioOperacionalPdf({
      cliente:     { nome: 'Cliente Sem Live' },
      periodo:     { mes: 1, ano: 2026 },
      operacional: OPERACIONAL_COMPLETO,
      sessoes:     { sessoes: [] },
    })

    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.slice(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(1024)
  })
})

// ---------------------------------------------------------------------------
// Testes da rota HTTP
// ---------------------------------------------------------------------------

describe('GET /v1/cliente/relatorio.pdf', () => {
  afterEach(() => vi.restoreAllMocks())

  it('200 + content-type application/pdf + filename no header', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()

    setQueryMock(seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      METRICS_COMPLETO,
      { rows: [SESSAO_ROW] }, // sessões
    ]))

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url:    '/v1/cliente/relatorio.pdf?mes=6&ano=2026',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/pdf/)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    expect(res.headers['content-disposition']).toMatch(/relatorio-operacional-2026-06\.pdf/)

    // Corpo é um PDF real
    const body = res.rawPayload
    expect(body.slice(0, 5).toString()).toBe('%PDF-')
    expect(body.length).toBeGreaterThan(1024)

    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('200 com métricas tendo clicks null e comissão apresentadora null', async () => {
    const { app, setQueryMock } = buildApp()

    setQueryMock(seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      METRICS_NULLS,
      { rows: [] }, // sem sessões
    ]))

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url:    '/v1/cliente/relatorio.pdf?mes=3&ano=2026',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/pdf/)
    expect(res.headers['content-disposition']).toMatch(/relatorio-operacional-2026-03\.pdf/)

    await app.close()
  })

  it('403 para papel diferente de cliente_parceiro', async () => {
    const { app } = buildApp({ papel: 'franqueado' })

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url:    '/v1/cliente/relatorio.pdf?mes=6&ano=2026',
    })

    expect(res.statusCode).toBe(403)

    await app.close()
  })

  it('404 quando cliente não encontrado para o usuário', async () => {
    const { app, setQueryMock } = buildApp()

    setQueryMock(seqMock([
      USER_ROW,
      { rows: [] }, // sem cliente ativo
    ]))

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url:    '/v1/cliente/relatorio.pdf?mes=6&ano=2026',
    })

    expect(res.statusCode).toBe(404)

    await app.close()
  })
})
