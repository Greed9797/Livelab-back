import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
// Fixtures reutilizáveis
// ---------------------------------------------------------------------------

const USER_ROW    = { rows: [{ email: 'parceiro@test.com' }] }
const CLIENTE_ROW = { rows: [{ id: 'cli-1', nicho: 'Moda', nome: 'Parceiro' }] }
const NO_ROWS     = { rows: [] }

const CONFIG_COMPLETA = { rows: [{ meta_gmv_hora: '500', margem_pct: '15' }] }

const CONTRATO_ATIVO = {
  rows: [{
    id:                'ctr-1',
    comissao_pct:      '10',
    valor_fixo:        '2400',
    horas_contratadas: '12',
    pacote_valor:      null,
    horas_incluidas:   null,
  }],
}

// Sessão completa — tudo medido, encerrada
function makeSessaoRow(overrides = {}) {
  return {
    id:                            'live-1',
    iniciado_em:                   '2026-06-07T22:00:00.000Z', // sábado 19h SP (UTC-3)
    encerrado_em:                  '2026-06-07T25:10:00.000Z', // ~3.17h depois
    status:                        'encerrada',
    fat_gerado:                    '1580',
    comissao_calculada:            '158',
    comissao_apresentadora_valor:  '31.6',
    comissao_apresentadora_pct:    '2',
    clicks:                        '200',
    status_operacional:            null,
    problema:                      null,
    proxima_acao:                  null,
    final_peak_viewers:            '8200',
    final_orders_count:            '42',
    apresentadora_nome:            'Maria',
    total_count:                   '1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('GET /v1/cliente/sessoes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── 1. Sessão com tudo medido → ratios calculados corretamente ───────────
  it('sessão completa com todos os campos → ratios calculados', async () => {
    const { app, setQueryMock, releaseMock } = buildApp()

    const row = makeSessaoRow({
      // live de sábado 22h UTC = sábado 19h SP (UTC-3)
      iniciado_em:  '2026-06-06T22:00:00.000Z',
      encerrado_em: '2026-06-07T01:10:00.000Z', // 3.17h depois
      fat_gerado:   '1580',
      final_orders_count: '42',
      final_peak_viewers: '8200',
    })

    setQueryMock(seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      { rows: [row] },
    ]))

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes?mes=6&ano=2026' })

    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.total).toBe(1)
    expect(body.sessoes).toHaveLength(1)

    const s = body.sessoes[0]
    expect(s.live_id).toBe('live-1')
    expect(s.gmv).toBe(1580)
    expect(s.pedidos).toBe(42)
    expect(s.views).toBe(8200)
    expect(s.clicks).toBe(200)
    expect(s.horas).toBeGreaterThan(0)
    // gmv_por_hora = 1580 / horas — não deve ser null
    expect(s.gmv_por_hora).not.toBeNull()
    // pedidos_por_hora — não deve ser null
    expect(s.pedidos_por_hora).not.toBeNull()
    expect(s.comissao_livelab).toBe(158)
    expect(s.comissao_apresentadora).toBe(31.6)
    expect(s.comissao_apresentadora_pct).toBe(2)
    expect(s.apresentadora).toBe('Maria')

    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // ── 2. clicks e views null → null mantido + status calculado on-the-fly ──
  it('clicks e views null → null mantido, status calculado pelo motor', async () => {
    const { app, setQueryMock } = buildApp()

    const row = makeSessaoRow({
      clicks:              null,
      final_peak_viewers:  null,
      status_operacional:  null,  // força motor
    })

    setQueryMock(seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      { rows: [row] },
    ]))

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(200)

    const s = res.json().sessoes[0]
    expect(s.clicks).toBeNull()
    expect(s.views).toBeNull()
    // motor deve retornar dados_incompletos porque clicks é null
    expect(s.status_operacional).toBe('dados_incompletos')

    await app.close()
  })

  // ── 3. Live de sábado → fim_de_semana true ────────────────────────────────
  it('live iniciada em sábado SP → fim_de_semana true', async () => {
    const { app, setQueryMock } = buildApp()

    // 2026-06-06 22:00 UTC = 2026-06-06 19:00 SP (sábado)
    const row = makeSessaoRow({
      iniciado_em: '2026-06-06T22:00:00.000Z',
    })

    setQueryMock(seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      { rows: [row] },
    ]))

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(200)

    const s = res.json().sessoes[0]
    expect(s.fim_de_semana).toBe(true)
    // data deve ser 2026-06-06 (sábado SP, não domingo UTC)
    expect(s.data).toBe('2026-06-06')

    await app.close()
  })

  // ── 4. status_operacional pré-gravado tem precedência sobre o motor ───────
  it('status_operacional gravado na coluna tem precedência sobre motor', async () => {
    const { app, setQueryMock } = buildApp()

    const row = makeSessaoRow({
      status_operacional: 'critico',  // pré-gravado
      clicks:             null,       // motor daria dados_incompletos
    })

    setQueryMock(seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      { rows: [row] },
    ]))

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(200)

    const s = res.json().sessoes[0]
    // coluna deve prevalecer sobre motor
    expect(s.status_operacional).toBe('critico')

    await app.close()
  })

  // ── 5. Ordenação DESC por iniciado_em + limit/offset ─────────────────────
  it('ordenação DESC e paginação limit/offset são repassados ao SQL', async () => {
    const { app, queryMock, releaseMock } = buildApp()

    // Retornar duas sessões em ordem DESC
    const row1 = makeSessaoRow({ id: 'live-2', iniciado_em: '2026-06-08T20:00:00.000Z', total_count: '5' })
    const row2 = makeSessaoRow({ id: 'live-1', iniciado_em: '2026-06-07T20:00:00.000Z', total_count: '5' })

    queryMock
      .mockResolvedValueOnce(USER_ROW)
      .mockResolvedValueOnce(CLIENTE_ROW)
      .mockResolvedValueOnce(CONFIG_COMPLETA)
      .mockResolvedValueOnce(CONTRATO_ATIVO)
      .mockResolvedValueOnce({ rows: [row1, row2] })

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes?limit=2&offset=0' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.total).toBe(5)  // total_count da janela
    expect(body.sessoes).toHaveLength(2)
    // primeira da lista deve ser a mais recente
    expect(body.sessoes[0].live_id).toBe('live-2')
    expect(body.sessoes[1].live_id).toBe('live-1')

    // SQL deve conter ORDER BY l.iniciado_em DESC, LIMIT $5 OFFSET $6
    const sql = queryMock.mock.calls[4][0]
    expect(sql).toContain('ORDER BY l.iniciado_em DESC')
    expect(sql).toContain('LIMIT $5 OFFSET $6')

    // Parâmetros: [tenant_id, cliente_id, ano, mes, limit=2, offset=0]
    const params = queryMock.mock.calls[4][1]
    expect(params[4]).toBe(2)
    expect(params[5]).toBe(0)

    expect(releaseMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  // ── 6. 403 para papel errado ──────────────────────────────────────────────
  it('papel diferente de cliente_parceiro → 403', async () => {
    const { app } = buildApp({ papel: 'franqueado' })

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(403)

    await app.close()
  })

  // ── 7. Live em andamento → horas parciais (não null) ─────────────────────
  it('live em andamento (sem encerrado_em) → horas parciais calculadas', async () => {
    const { app, setQueryMock } = buildApp()

    // sem encerrado_em e status em_andamento
    const row = makeSessaoRow({
      encerrado_em: null,
      status:       'em_andamento',
    })

    setQueryMock(seqMock([
      USER_ROW,
      CLIENTE_ROW,
      CONFIG_COMPLETA,
      CONTRATO_ATIVO,
      { rows: [row] },
    ]))

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes' })
    expect(res.statusCode).toBe(200)

    const s = res.json().sessoes[0]
    // horas parciais devem ser ≥ 0 (positivas, pois live ainda decorre)
    expect(s.horas).toBeGreaterThanOrEqual(0)
    // fim deve ser null
    expect(s.fim).toBeNull()

    await app.close()
  })

  // ── 8. sem cliente vinculado → payload vazio ─────────────────────────────
  it('sem cliente vinculado → retorna total 0 e sessoes []', async () => {
    const { app, queryMock } = buildApp()

    // user encontrado mas sem cliente ativo
    queryMock
      .mockResolvedValueOnce(USER_ROW)
      .mockResolvedValueOnce({ rows: [] }) // getClienteVinculado — sem cliente ativo

    await app.register(clienteDashboardRoutes)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/cliente/sessoes?mes=6&ano=2026' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.total).toBe(0)
    expect(body.sessoes).toHaveLength(0)
    expect(body.periodo.mes).toBe(6)
    expect(body.periodo.ano).toBe(2026)

    await app.close()
  })
})
