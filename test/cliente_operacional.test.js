import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Cria um queryMock a partir de um array de respostas sequenciais
function seqMock(responses) {
  let i = 0
  return vi.fn().mockImplementation(() => {
    const r = responses[i] ?? { rows: [] }
    i++
    return Promise.resolve(r)
  })
}

// ---------------------------------------------------------------------------
// Respostas-base de mock reutilizadas pelos testes
// ---------------------------------------------------------------------------

const USER_ROW    = { rows: [{ email: 'parceiro@test.com' }] }
const CLIENTE_ROW = { rows: [{ id: 'cli-1', nicho: 'Moda', nome: 'Parceiro' }] }
const NO_ROWS     = { rows: [] }

// Config padrão completa (margem preenchida)
const CONFIG_COMPLETA  = { rows: [{ meta_gmv_hora: '500', margem_pct: '15' }] }
// Config com margem nula
const CONFIG_SEM_MARGEM = { rows: [{ meta_gmv_hora: '500', margem_pct: null }] }

const CONTRATO_ATIVO = { rows: [{ id: 'ctr-1', comissao_pct: '10', valor_fixo: '2400', horas_contratadas: '12', pacote_valor: null, horas_incluidas: null }] }

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('GET /v1/cliente/operacional', () => {

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── 1. clicks todos null → funil.clicks null (não 0) ─────────────────────
  it('clicks todos null → funil.clicks é null', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()
    const mockFn = seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      // Metrics: duas lives encerradas, clicks null em ambas
      {
        rows: [{
          horas_live: '2.00',
          gmv: '3000',
          comissao_livelab_total: '300',
          comissao_apresentadora_total: '60',
          views: '5000',
          clicks: null,  // ← nenhuma live com clicks medidos
          pedidos: '40',
          primeiro_problema: null,
        }],
      },
      NO_ROWS, // alertas
    ])
    setQueryMock(mockFn)
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional?mes=5&ano=2026' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metricas.funil.clicks).toBeNull()
    expect(body.metricas.funil.views).toBe(5000)
    expect(body.metricas.funil.pedidos).toBe(40)
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  // ── 2. clicks parcialmente medidos → soma só dos medidos ─────────────────
  it('clicks parcialmente medidos → retorna soma (não null)', async () => {
    const { app, setQueryMock } = buildApp()
    const mockFn = seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      {
        rows: [{
          horas_live: '3.00',
          gmv: '4500',
          comissao_livelab_total: '450',
          comissao_apresentadora_total: '90',
          views: '9000',
          clicks: '450', // ← pelo menos uma live tem clicks medidos
          pedidos: '60',
          primeiro_problema: null,
        }],
      },
      NO_ROWS, // alertas
    ])
    setQueryMock(mockFn)
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional?mes=5&ano=2026' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metricas.funil.clicks).toBe(450)

    await app.close()
  })

  // ── 3. margem_pct null → status dados_incompletos com motivo ─────────────
  it('margem null → status dados_incompletos contendo motivo de margem', async () => {
    const { app, setQueryMock } = buildApp()
    const mockFn = seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_SEM_MARGEM, // margem_pct: null
      CONTRATO_ATIVO,
      {
        rows: [{
          horas_live: '2.50',
          gmv: '1500',
          comissao_livelab_total: '150',
          comissao_apresentadora_total: null,
          views: '3000',
          clicks: null,
          pedidos: '20',
          primeiro_problema: null,
        }],
      },
      NO_ROWS, // alertas
    ])
    setQueryMock(mockFn)
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status.status).toBe('dados_incompletos')
    expect(body.status.motivos.some(m => /margem/i.test(m))).toBe(true)
    expect(body.config.margem_pct).toBeNull()

    await app.close()
  })

  // ── 4. meta batida + config completa → ok, pct_meta_hora correto ─────────
  it('config completa + meta batida → status ok e pct_meta_hora correto', async () => {
    const { app, setQueryMock } = buildApp()
    const mockFn = seqMock([
      USER_ROW,
      CLIENTE_ROW,
      { rows: [{ meta_gmv_hora: '500', margem_pct: '15' }] },
      CONTRATO_ATIVO, // comissao_pct = 10
      {
        rows: [{
          horas_live: '4.00',
          gmv: '2400',   // gmv_por_hora = 600 > meta 500
          comissao_livelab_total: '240',
          comissao_apresentadora_total: '48',
          views: '10000',
          clicks: '1000',
          pedidos: '80',
          primeiro_problema: null,
        }],
      },
      NO_ROWS, // alertas
    ])
    setQueryMock(mockFn)
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional?mes=5&ano=2026' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status.status).toBe('ok')
    // gmv_por_hora = 2400/4 = 600; pct_meta_hora = (600/500)*100 = 120
    expect(body.metricas.gmv_por_hora).toBe(600)
    expect(body.metricas.pct_meta_hora).toBe(120)
    expect(body.config.comissao_livelab_pct).toBe(10)

    await app.close()
  })

  // ── 5. live 2h gmv 0 → alerta crítico presente + status critico ──────────
  it('live encerrada 2h gmv 0 → alerta crítico presente e status critico', async () => {
    const { app, setQueryMock } = buildApp()
    const mockFn = seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      {
        rows: [{
          horas_live: '2.00',
          gmv: '0',
          comissao_livelab_total: null,
          comissao_apresentadora_total: null,
          views: '3000',
          clicks: null,
          pedidos: '0',
          primeiro_problema: null,
        }],
      },
      // Alertas: uma live crítica com duração >= 1h e fat_gerado = 0
      {
        rows: [{
          id: 'live-crit-1',
          status_operacional: 'critico',
          problema: null,
          iniciado_em: '2026-05-10T20:00:00.000Z',
          encerrado_em: '2026-05-10T22:00:00.000Z',
          fat_gerado: '0',
          duracao_horas: '2',
        }],
      },
    ])
    setQueryMock(mockFn)
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional?mes=5&ano=2026' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // status do período deve ser critico (gmv=0 com horas>=1)
    expect(body.status.status).toBe('critico')
    // alerta deve estar presente
    expect(body.alertas.length).toBeGreaterThanOrEqual(1)
    expect(body.alertas[0].tipo).toBe('critico')
    expect(body.alertas[0].live_id).toBe('live-crit-1')

    await app.close()
  })

  // ── 6. denominador zero → ratios null ────────────────────────────────────
  it('horas_live = 0 → gmv_por_hora, pct_meta_hora e comissao_por_hora são null', async () => {
    const { app, setQueryMock } = buildApp()
    const mockFn = seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      {
        rows: [{
          horas_live: '0',
          gmv: '0',
          comissao_livelab_total: null,
          comissao_apresentadora_total: null,
          views: '0',
          clicks: null,
          pedidos: '0',
          primeiro_problema: null,
        }],
      },
      NO_ROWS, // alertas
    ])
    setQueryMock(mockFn)
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metricas.gmv_por_hora).toBeNull()
    expect(body.metricas.pct_meta_hora).toBeNull()
    expect(body.metricas.comissao_por_hora).toBeNull()

    await app.close()
  })

  // ── 7. RBAC: papel sem permissão → 403 ───────────────────────────────────
  it('papel franqueado → 403', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })

    expect(res.statusCode).toBe(403)

    await app.close()
  })

  // ── 8. RBAC: papel gerente → 403 ────────────────────────────────────────
  it('papel gerente → 403', async () => {
    const { app } = buildApp({ papel: 'gerente' })
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })

    expect(res.statusCode).toBe(403)

    await app.close()
  })

  // ── 9. cliente não encontrado → empty payload (não 404) ──────────────────
  it('usuário sem cliente vinculado → empty payload com dados_incompletos', async () => {
    const { app, setQueryMock } = buildApp()
    const mockFn = seqMock([
      USER_ROW,
      NO_ROWS, // cliente não encontrado
    ])
    setQueryMock(mockFn)
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metricas.funil.clicks).toBeNull()
    expect(body.metricas.gmv).toBe(0)
    expect(body.status.status).toBe('dados_incompletos')

    await app.close()
  })

  // ── 10. db.release sempre chamado (mesmo com erro) ───────────────────────
  it('release é chamado mesmo quando a query falha', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()
    const mockFn = seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      // Metrics query explode
      Promise.reject(new Error('DB error')),
    ])
    setQueryMock(mockFn)
    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/operacional' })

    expect(res.statusCode).toBe(500)
    expect(releaseMock).toHaveBeenCalledTimes(1)

    await app.close()
  })
})
