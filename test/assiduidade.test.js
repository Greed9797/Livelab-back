import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { analyticsRoutes } from '../src/routes/analytics.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const anaId = '44444444-4444-4444-8444-444444444444'
const biaId = '55555555-5555-4555-8555-555555555555'

// Semana escolhida a dedo por cobrir a matriz inteira em 7 dias:
//   01/09 ter útil · 02/09 qua FERIADO (Aniversário de Blumenau) · 03/09 qui útil · 04/09 sex útil
//   05/09 sáb · 06/09 dom · 07/09 seg FERIADO (Independência)
// O 02/09 e o 07/09 são o caso que a feature existe para não errar: feriado em dia de semana.
const INICIO = '2026-09-01'
const FIM = '2026-09-07'

// "Hoje" congelado depois da janela toda, senão o corte de dia futuro encolheria o período e o
// teste passaria a depender da data em que roda.
const HOJE = '2026-09-20'

function buildApp(queryMock) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query: queryMock }))
  return app
}

async function chamar(queryMock, url) {
  const app = buildApp(queryMock)
  await app.register(analyticsRoutes)
  return app.inject({ method: 'GET', url })
}

const statusPorDia = (apresentadora) => Object.fromEntries(
  apresentadora.dias.map((d) => [d.data, d.status]),
)

describe('GET /v1/analytics/assiduidade', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${HOJE}T15:00:00.000Z`)) // meio-dia em São Paulo
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pinta a matriz inteira: dia útil a 5,5h, fim de semana e feriado a 4h', async () => {
    const rows = [
      // Ana — um caso de cada cor.
      { id: anaId, nome: 'Ana', dia: '2026-09-01', horas: '6.0' },   // útil cheio
      { id: anaId, nome: 'Ana', dia: '2026-09-02', horas: '4.5' },   // feriado, acima das 4h
      { id: anaId, nome: 'Ana', dia: '2026-09-03', horas: '3.0' },   // útil incompleto
      //          04/09 útil sem live -> falta
      { id: anaId, nome: 'Ana', dia: '2026-09-05', horas: '2.0' },   // sábado incompleto
      //          06/09 domingo sem live -> folga
      //          07/09 feriado sem live -> folga, NUNCA falta
      // Bia — os valores em cima da linha, que separam 5,5 de 4,0.
      { id: biaId, nome: 'Bia', dia: '2026-09-01', horas: '5.5' },   // exatamente a meta útil
      { id: biaId, nome: 'Bia', dia: '2026-09-02', horas: '5.4' },   // feriado: passa pela meta de folga
      { id: biaId, nome: 'Bia', dia: '2026-09-03', horas: '5.4' },   // útil: 0,1h abaixo da meta
      { id: biaId, nome: 'Bia', dia: '2026-09-05', horas: '4.0' },   // exatamente a meta de folga
      { id: biaId, nome: 'Bia', dia: '2026-09-06', horas: '3.9' },   // domingo abaixo da meta
    ]
    const queryMock = vi.fn(async () => ({ rows }))

    const res = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.inicio).toBe(INICIO)
    expect(body.fim).toBe(FIM)
    expect(body.dias).toEqual([
      { data: '2026-09-01', tipo: 'util', feriado: null },
      { data: '2026-09-02', tipo: 'feriado', feriado: 'Aniversário de Blumenau' },
      { data: '2026-09-03', tipo: 'util', feriado: null },
      { data: '2026-09-04', tipo: 'util', feriado: null },
      { data: '2026-09-05', tipo: 'fim_de_semana', feriado: null },
      { data: '2026-09-06', tipo: 'fim_de_semana', feriado: null },
      { data: '2026-09-07', tipo: 'feriado', feriado: 'Independência' },
    ])

    const [ana, bia] = body.apresentadoras
    expect(ana.nome).toBe('Ana')
    expect(statusPorDia(ana)).toEqual({
      '2026-09-01': 'verde',
      '2026-09-02': 'verde',
      '2026-09-03': 'amarelo',
      '2026-09-04': 'vermelho',
      '2026-09-05': 'amarelo',
      '2026-09-06': 'cinza',
      '2026-09-07': 'cinza',
    })
    expect(ana.resumo).toEqual({ verde: 2, amarelo: 2, vermelho: 1, cinza: 2, horas_total: 15.5 })

    expect(bia.nome).toBe('Bia')
    expect(statusPorDia(bia)).toEqual({
      '2026-09-01': 'verde',   // 5,5 bate a meta útil na igualdade
      '2026-09-02': 'verde',   // 5,4 em FERIADO passa: a meta ali é 4,0
      '2026-09-03': 'amarelo', // as mesmas 5,4 em DIA ÚTIL não passam
      '2026-09-04': 'vermelho',
      '2026-09-05': 'verde',   // 4,0 bate a meta de folga na igualdade
      '2026-09-06': 'amarelo', // 3,9 não bate
      '2026-09-07': 'cinza',
    })
    expect(bia.resumo).toEqual({ verde: 3, amarelo: 2, vermelho: 1, cinza: 1, horas_total: 24.2 })
  })

  it('apresentadora ativa sem nenhuma live: vermelho nos dias úteis, cinza na folga', async () => {
    // É o formato que o LEFT JOIN devolve para quem não fez live nenhuma na janela.
    const queryMock = vi.fn(async () => ({
      rows: [{ id: anaId, nome: 'Ana', dia: null, horas: null }],
    }))

    const res = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)
    expect(res.statusCode).toBe(200)
    const [ana] = res.json().apresentadoras

    expect(ana.dias).toHaveLength(7)
    expect(statusPorDia(ana)).toEqual({
      '2026-09-01': 'vermelho',
      '2026-09-02': 'cinza',
      '2026-09-03': 'vermelho',
      '2026-09-04': 'vermelho',
      '2026-09-05': 'cinza',
      '2026-09-06': 'cinza',
      '2026-09-07': 'cinza',
    })
    expect(ana.resumo).toEqual({ verde: 0, amarelo: 0, vermelho: 3, cinza: 4, horas_total: 0 })
  })

  it('apresentadora que trabalhou e vendeu zero aparece verde (o caso que o HAVING mataria)', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [{ id: anaId, nome: 'Ana', dia: '2026-09-01', horas: '6.0' }],
    }))

    const res = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)
    const sql = queryMock.mock.calls[0][0]

    // Nada de GMV/pedidos na consulta: presença é hora, não venda.
    expect(sql).not.toContain('HAVING')
    expect(sql).not.toContain('ads_gmv')
    expect(res.json().apresentadoras[0].dias[0]).toEqual({
      data: '2026-09-01', horas: 6, status: 'verde',
    })
  })

  it('monta o SQL com fan-out de revezamento, sem filtro de marca e só com live encerrada', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }))
    await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)

    const [sql, params] = queryMock.mock.calls[0]
    expect(params).toEqual([INICIO, FIM])
    // Sem LIMIT 1 na LATERAL: com ele a principal levaria 100% das horas e a apoio sumiria do dia.
    expect(sql).toContain('FROM live_apresentadoras_v2 lav')
    expect(sql).not.toMatch(/^\s*LIMIT\s/mi) // cláusula de verdade, não a citação no comentário
    // A cascata de 3 degraus, na ordem, vinda de apresentadoraHorasSql().
    expect(sql).toContain('ap_v2.segundos_rateio / 3600.0')
    expect(sql).toContain('ap_v2.percentual_rateio / 100.0')
    expect(sql).toContain("ap_v2.papel = 'principal'")
    // Presença é física: marca não filtra.
    expect(sql).not.toMatch(/marca_id\s*=/)
    expect(sql).toContain("l.status = 'encerrada'")
    expect(sql).toContain("(l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date")
    // Ativas de hoje MAIS quem fez live na janela.
    expect(sql).toContain('a.ativo IS TRUE')
    expect(sql).toContain('h.apresentadora_id IS NOT NULL')
  })

  it('sem parâmetros usa os últimos 30 dias terminando hoje em São Paulo', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }))
    const res = await chamar(queryMock, '/v1/analytics/assiduidade')

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.inicio).toBe('2026-08-22')
    expect(body.fim).toBe(HOJE)
    expect(body.dias).toHaveLength(30)
    expect(queryMock.mock.calls[0][1]).toEqual(['2026-08-22', HOJE])
  })

  it('não trata dia futuro como falta: corta a janela em hoje', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }))
    const res = await chamar(queryMock, '/v1/analytics/assiduidade?inicio=2026-09-18&fim=2026-09-25')

    const body = res.json()
    expect(body.fim).toBe(HOJE)
    expect(body.dias.map((d) => d.data)).toEqual(['2026-09-18', '2026-09-19', '2026-09-20'])
    expect(queryMock.mock.calls[0][1]).toEqual(['2026-09-18', HOJE])
  })

  it('aceita 366 dias e recusa 367', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }))

    const ok = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=2025-09-20&fim=${HOJE}`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().dias).toHaveLength(366)

    const demais = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=2025-09-19&fim=${HOJE}`)
    expect(demais.statusCode).toBe(400)
    expect(demais.json().error).toContain('366')
  })

  it('recusa data malformada e intervalo invertido', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }))

    const formato = await chamar(queryMock, '/v1/analytics/assiduidade?inicio=01/09/2026&fim=2026-09-07')
    expect(formato.statusCode).toBe(400)

    const invertido = await chamar(queryMock, '/v1/analytics/assiduidade?inicio=2026-09-07&fim=2026-09-01')
    expect(invertido.statusCode).toBe(400)

    expect(queryMock).not.toHaveBeenCalled()
  })
})

/**
 * Os limiares viajam no payload porque a legenda da tela precisa nomeá-los. Sem isso o front
 * repete 5,5/4,0 na mão e mudar o limiar aqui deixa a tela afirmando um número que não é mais
 * o aplicado — a mesma divergência que fez a expressão de horas existir em 4 cópias no repo.
 */
describe('GET /v1/analytics/assiduidade — limiares no payload', () => {
  it('devolve as metas que usou para classificar', async () => {
    const app = buildApp(async () => ({ rows: [] }))
    await app.register(analyticsRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/assiduidade?inicio=2026-09-01&fim=2026-09-07' })
    expect(res.statusCode).toBe(200)
    expect(res.json().metas).toEqual({ dia_util_horas: 5.5, folga_horas: 4 })
    await app.close()
  })
})
