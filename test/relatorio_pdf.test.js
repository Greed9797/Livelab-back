/**
 * Testes de GET /v1/cliente/relatorio.pdf
 *
 * Endpoint em src/routes/cliente_insights.js
 * Cobre: headers corretos (Content-Type, Content-Disposition, Cache-Control, Pragma),
 *        404 quando cliente não encontrado, release garantido, Buffer retornado.
 */

import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clienteInsightsRoutes } from '../src/routes/cliente_insights.js'

// ---------------------------------------------------------------------------
// Setup
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
  app.decorate('withTenant', async (tid, fn) => {
    const db = await app.dbTenant(tid)
    try { return await fn(db) } finally { db.release() }
  })

  return { app, releaseMock, setQueryMock: (fn) => { queryMock = fn } }
}

function seqMock(responses) {
  let i = 0
  return vi.fn().mockImplementation(() => {
    const r = responses[i] ?? { rows: [] }
    i++
    return Promise.resolve(r)
  })
}

// Respostas base reutilizáveis
const CLIENTE_ROW    = { rows: [{ id: 'cli-1', nome: 'Parceiro Teste', nicho: 'Moda' }] }
const CONFIG_LINHA   = { rows: [{ meta_gmv_hora: '500', margem_pct: '30' }] }
const CONTRATO_ATIVO = { rows: [{ id: 'ct-1', comissao_pct: '10', valor_fixo: '1000', horas_contratadas: '40', horas_consumidas: '10' }] }
const NO_ROWS        = { rows: [] }

// Métricas agregadas do período
const METRICAS_ROW = {
  rows: [{
    horas_live:                    '3.00',
    gmv:                           '9000',
    comissao_livelab_total:        '900',
    comissao_apresentadora_total:  '180',
    views:                         '15000',
    clicks:                        '450',
    pedidos:                       '75',
    primeiro_problema:             null,
  }],
}

// Uma sessão para o relatório
const SESSAO_ROW = {
  rows: [{
    id:                             'live-1',
    iniciado_em:                    '2026-05-10T18:00:00-03:00',
    encerrado_em:                   '2026-05-10T21:00:00-03:00',
    status:                         'encerrada',
    fat_gerado:                     '3000',
    comissao_calculada:             '300',
    comissao_apresentadora_valor:   '60',
    comissao_apresentadora_pct:     '2',
    clicks:                         '150',
    views_raw:                      '5000',
    status_operacional:             null,
    problema:                       null,
    proxima_acao:                   null,
    final_orders_count:             '25',
    apresentadora_nome:             'Ana Lima',
    total_count:                    '1',
  }],
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('GET /v1/cliente/relatorio.pdf', () => {
  afterEach(() => vi.restoreAllMocks())

  // ── 1. headers corretos ───────────────────────────────────────────────────
  it('retorna Content-Type application/pdf e Content-Disposition attachment', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      METRICAS_ROW,
      SESSAO_ROW,
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/relatorio.pdf' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/pdf/)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    expect(res.headers['content-disposition']).toMatch(/\.pdf/)
    await app.close()
  })

  // ── 2. Cache-Control e Pragma anti-cache ──────────────────────────────────
  it('retorna headers de cache no-store e Pragma no-cache', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      METRICAS_ROW,
      SESSAO_ROW,
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/relatorio.pdf' })
    expect(res.statusCode).toBe(200)
    const cc = res.headers['cache-control'] ?? ''
    expect(cc).toMatch(/no-store/)
    expect(cc).toMatch(/no-cache/)
    expect(cc).toMatch(/must-revalidate/)
    expect(cc).toMatch(/private/)
    expect(res.headers['pragma']).toBe('no-cache')
    await app.close()
  })

  // ── 3. corpo é um Buffer PDF (começa com %PDF) ───────────────────────────
  it('corpo da resposta é um PDF válido (começa com %PDF)', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      METRICAS_ROW,
      SESSAO_ROW,
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/relatorio.pdf' })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.slice(0, 4).toString()).toBe('%PDF')
    await app.close()
  })

  // ── 4. 404 quando cliente não encontrado ──────────────────────────────────
  it('retorna 404 quando cliente não está vinculado ao usuário', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([NO_ROWS]))  // getClienteVinculado retorna vazio

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/relatorio.pdf' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/Cliente não encontrado/)
    await app.close()
  })

  // ── 5. 403 para papel errado ──────────────────────────────────────────────
  it('retorna 403 para papel não autorizado', async () => {
    const { app, setQueryMock } = buildApp({ papel: 'franqueado' })
    setQueryMock(seqMock([]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/relatorio.pdf' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ── 6. release garantido mesmo com cliente encontrado ────────────────────
  it('release é chamado sempre (cliente encontrado)', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      METRICAS_ROW,
      SESSAO_ROW,
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/relatorio.pdf' })
    expect(res.statusCode).toBe(200)
    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // ── 7. release garantido quando cliente não encontrado (404 path) ─────────
  it('release é chamado mesmo no path 404', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()
    setQueryMock(seqMock([NO_ROWS]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/relatorio.pdf' })
    expect(res.statusCode).toBe(404)
    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // ── 8. período via query string é respeitado ──────────────────────────────
  it('aceita query string mes/ano sem erros', async () => {
    const { app, setQueryMock } = buildApp()
    setQueryMock(seqMock([
      CLIENTE_ROW,
      CONFIG_LINHA,
      CONTRATO_ATIVO,
      METRICAS_ROW,
      SESSAO_ROW,
    ]))

    await app.register(clienteInsightsRoutes)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/v1/cliente/relatorio.pdf?mes=3&ano=2026',
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/pdf/)
    await app.close()
  })
})
