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

// A query passou a devolver o vínculo (data_inicio/data_fim/criado_em) e se a apresentadora tem
// histórico operacional. Este helper carimba "contratada há anos, com histórico" nas fixturas que
// não estão testando vínculo, para elas continuarem medindo só o que se propõem a medir.
const comVinculoAntigo = (rows) => rows.map((row) => ({
  data_inicio: '2020-01-01',
  data_fim: null,
  criado_em_dia: '2020-01-01',
  tem_historico: true,
  ...row,
}))

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
    const queryMock = vi.fn(async () => ({ rows: comVinculoAntigo(rows) }))

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
    expect(ana.resumo).toEqual({ verde: 2, amarelo: 2, vermelho: 1, cinza: 2, em_curso: 0, fora_do_vinculo: 0, horas_total: 15.5 })

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
    expect(bia.resumo).toEqual({ verde: 3, amarelo: 2, vermelho: 1, cinza: 1, em_curso: 0, fora_do_vinculo: 0, horas_total: 24.2 })
  })

  it('apresentadora COM vínculo declarado e sem nenhuma live: vermelho nos dias úteis, cinza na folga', async () => {
    // É o formato que o LEFT JOIN devolve para quem não fez live nenhuma na janela. Com
    // data_inicio preenchida a operação declarou que ela devia estar lá — aí a falta é falta.
    const queryMock = vi.fn(async () => ({
      rows: comVinculoAntigo([{ id: anaId, nome: 'Ana', dia: null, horas: null }]),
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
    expect(ana.resumo).toEqual({ verde: 0, amarelo: 0, vermelho: 3, cinza: 4, em_curso: 0, fora_do_vinculo: 0, horas_total: 0 })
  })

  it('apresentadora que trabalhou e vendeu zero aparece verde (o caso que o HAVING mataria)', async () => {
    const queryMock = vi.fn(async () => ({
      rows: comVinculoAntigo([{ id: anaId, nome: 'Ana', dia: '2026-09-01', horas: '6.0' }]),
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
    // A cascata de PRESENÇA (apresentadoraHorasPresencaSql), não a de produtividade.
    // A diferença não é cosmética: a de produtividade usa percentual_rateio cru, e no rateio
    // pós-live por valor esse percentual sai de gmv/gmvTotal — quem vendeu R$ 0 ficava com 0h
    // e o painel a acusava de não ter aparecido.
    expect(sql).toContain('NULLIF(ap_v2.segundos_rateio, 0) / 3600.0')
    expect(sql).toContain('LEAST(turno.horas_turno')
    expect(sql).toContain('ap_v2.gmv_rateado IS NULL')
    // percentual_rateio só é aceito DENTRO da guarda de rateio planejado.
    expect(sql).toMatch(/gmv_rateado IS NULL[\s\S]{0,600}?percentual_rateio \/ 100\.0/)
    // O degrau de papel='principal' é da régua do dinheiro e não pode voltar para cá.
    expect(sql).not.toContain("ap_v2.papel = 'principal'")
    // Presença é física: marca não filtra.
    expect(sql).not.toMatch(/marca_id\s*=/)
    expect(sql).toContain("l.status = 'encerrada'")
    expect(sql).toContain("(l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date")

    // Legado live_apresentadores entra por UNION: a 2ª apresentadora do lançamento manual só
    // existe lá, e sem isto ela contribui 0h e leva vermelho num dia que trabalhou inteiro.
    expect(sql).toContain('FROM live_apresentadores la')
    // Turno real da agenda: separa co-apresentação (sobreposta) de revezamento (sequencial).
    expect(sql).toContain('FROM agenda_evento_apresentadoras aea')
    // Terceira identidade: a apresentadora do evento de agenda recupera a live sem atribuição.
    expect(sql).toContain('COALESCE(ap_v2.apresentadora_id, ae.apresentadora_id, ap_user.id)')
    // Vínculo e histórico viajam junto: sem eles a fileira cobra dias fora do contrato.
    expect(sql).toContain('a.data_inicio::text')
    expect(sql).toContain('a.data_fim::text')
    expect(sql).toContain('AS tem_historico')
    // ::timestamp, não ::date: com date o overload de timezone() lê a data no fuso da SESSÃO
    // (UTC) e a janela termina às 18:00 do último dia, matando a live das 19h de hoje.
    expect(sql).toContain('($1::timestamp) AT TIME ZONE')
    expect(sql).not.toContain('($1::date) AT TIME ZONE')
    expect(sql).not.toContain('($2::date) + 1')
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

/**
 * Vínculo — nenhum dia fora do contrato pode virar falta.
 *
 * `apresentadoras.data_inicio`/`data_fim` (migration 041) já mandam no rateio do fixo salarial
 * (financeiro.js). A folha respeitava a vigência e a assiduidade não: a fileira tinha o tamanho
 * da janela pedida, não o da interseção com o contrato.
 */
describe('GET /v1/analytics/assiduidade — janela de vínculo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${HOJE}T15:00:00.000Z`))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('contratada no meio da janela não leva falta nos dias anteriores à admissão', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [
        // Admitida na quinta 03/09; os dias úteis 01/09 e 02/09 são anteriores ao contrato.
        { id: anaId, nome: 'Ana', dia: '2026-09-03', horas: '6.0', data_inicio: '2026-09-03', data_fim: null, criado_em_dia: '2026-09-03', tem_historico: true },
        { id: anaId, nome: 'Ana', dia: '2026-09-04', horas: '6.0', data_inicio: '2026-09-03', data_fim: null, criado_em_dia: '2026-09-03', tem_historico: true },
      ],
    }))

    const res = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)
    const [ana] = res.json().apresentadoras

    expect(statusPorDia(ana)['2026-09-01']).toBe('fora_do_vinculo')
    expect(statusPorDia(ana)['2026-09-03']).toBe('verde')
    expect(ana.resumo.vermelho).toBe(0)
    // Fora do vínculo cobre a faixa inteira, folga inclusive: são dias em que ela não era
    // funcionária, e a tela pode desenhar a admissão como um bloco só.
    expect(ana.resumo.fora_do_vinculo).toBe(2) // 01/09 e 02/09
  })

  it('desligada no meio da janela não leva falta nos dias posteriores à saída', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [
        { id: biaId, nome: 'Bia', dia: '2026-09-01', horas: '6.0', data_inicio: '2020-01-01', data_fim: '2026-09-01', criado_em_dia: '2020-01-01', tem_historico: true },
      ],
    }))

    const res = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)
    const [bia] = res.json().apresentadoras

    expect(statusPorDia(bia)).toEqual({
      '2026-09-01': 'verde',
      '2026-09-02': 'fora_do_vinculo',
      '2026-09-03': 'fora_do_vinculo',
      '2026-09-04': 'fora_do_vinculo',
      '2026-09-05': 'fora_do_vinculo',
      '2026-09-06': 'fora_do_vinculo',
      '2026-09-07': 'fora_do_vinculo',
    })
    expect(bia.resumo.vermelho).toBe(0)
  })

  it('live registrada depois da data_fim ganha do campo: o dia continua sendo classificado', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [
        // data_fim está velha (01/09) mas ela fez live em 04/09 — o fato manda.
        { id: biaId, nome: 'Bia', dia: '2026-09-04', horas: '6.0', data_inicio: '2020-01-01', data_fim: '2026-09-01', criado_em_dia: '2020-01-01', tem_historico: true },
      ],
    }))

    const res = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)
    const [bia] = res.json().apresentadoras

    expect(statusPorDia(bia)['2026-09-04']).toBe('verde')
    // 03/09 volta a ser cobrado, porque o vínculo se estendeu até a última live.
    expect(statusPorDia(bia)['2026-09-03']).toBe('vermelho')
  })

  it('perfil sem data_inicio e sem nenhuma live na história não acusa falta', async () => {
    // É a assinatura do perfil DUPLICADO que a migration 110 insere quando o e-mail não casa:
    // nasce ativo, com o mesmo nome de quem realmente trabalha, e sem uma live sequer. Também
    // é a assinatura do cadastro recém-criado. Nos dois casos, 3 dias úteis de vermelho ao lado
    // de um nome próprio seriam invenção.
    const queryMock = vi.fn(async () => ({
      rows: [{ id: anaId, nome: 'Ana Paula', dia: null, horas: null, data_inicio: null, data_fim: null, criado_em_dia: '2024-01-10', tem_historico: false }],
    }))

    const res = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)
    const [perfil] = res.json().apresentadoras

    expect(perfil.resumo.vermelho).toBe(0)
    expect(perfil.resumo.fora_do_vinculo).toBe(7) // a janela inteira, sem vínculo comprovado
    expect(perfil.resumo.cinza).toBe(0)
  })

  it('mas perfil sem data_inicio COM histórico segue cobrado (não é o duplicado)', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [{ id: anaId, nome: 'Ana', dia: null, horas: null, data_inicio: null, data_fim: null, criado_em_dia: '2024-01-10', tem_historico: true }],
    }))

    const res = await chamar(queryMock, `/v1/analytics/assiduidade?inicio=${INICIO}&fim=${FIM}`)
    expect(res.json().apresentadoras[0].resumo.vermelho).toBe(3)
  })
})

/**
 * O dia de HOJE ainda não terminou. A CTE só enxerga live com status='encerrada', então toda
 * manhã de dia útil o último palitinho de TODA a equipe era vermelho — inclusive o de quem
 * estava ao vivo naquele instante.
 */
describe('GET /v1/analytics/assiduidade — dia corrente', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 2026-09-17 é uma quinta-feira útil, e HOJE (2026-09-20) é um domingo — por isso a janela
    // deste bloco termina numa data escolhida, não na constante do arquivo.
    vi.setSystemTime(new Date('2026-09-17T13:00:00.000Z')) // 10h em São Paulo
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hoje sem live nenhuma sai como em_curso, não como falta', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [{ id: anaId, nome: 'Ana', dia: '2026-09-16', horas: '6.0', data_inicio: '2020-01-01', data_fim: null, criado_em_dia: '2020-01-01', tem_historico: true }],
    }))

    const res = await chamar(queryMock, '/v1/analytics/assiduidade?inicio=2026-09-16&fim=2026-09-17')
    const [ana] = res.json().apresentadoras

    expect(statusPorDia(ana)).toEqual({ '2026-09-16': 'verde', '2026-09-17': 'em_curso' })
    expect(ana.resumo.vermelho).toBe(0)
    expect(ana.resumo.em_curso).toBe(1)
  })

  it('hoje com hora abaixo da meta também é em_curso: ainda dá tempo de bater', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [{ id: anaId, nome: 'Ana', dia: '2026-09-17', horas: '2.0', data_inicio: '2020-01-01', data_fim: null, criado_em_dia: '2020-01-01', tem_historico: true }],
    }))

    const res = await chamar(queryMock, '/v1/analytics/assiduidade?inicio=2026-09-17&fim=2026-09-17')
    expect(statusPorDia(res.json().apresentadoras[0])['2026-09-17']).toBe('em_curso')
  })

  it('hoje com a meta batida sai verde: dia em curso não esconde quem já cumpriu', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [{ id: anaId, nome: 'Ana', dia: '2026-09-17', horas: '6.0', data_inicio: '2020-01-01', data_fim: null, criado_em_dia: '2020-01-01', tem_historico: true }],
    }))

    const res = await chamar(queryMock, '/v1/analytics/assiduidade?inicio=2026-09-17&fim=2026-09-17')
    expect(statusPorDia(res.json().apresentadoras[0])['2026-09-17']).toBe('verde')
  })

  it('ontem, já encerrado, continua sendo cobrado como falta', async () => {
    const queryMock = vi.fn(async () => ({
      rows: [{ id: anaId, nome: 'Ana', dia: null, horas: null, data_inicio: '2020-01-01', data_fim: null, criado_em_dia: '2020-01-01', tem_historico: true }],
    }))

    const res = await chamar(queryMock, '/v1/analytics/assiduidade?inicio=2026-09-16&fim=2026-09-17')
    const [ana] = res.json().apresentadoras
    expect(statusPorDia(ana)).toEqual({ '2026-09-16': 'vermelho', '2026-09-17': 'em_curso' })
  })
})

describe('GET /v1/analytics/assiduidade — janela padrão ancorada no fim pedido', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${HOJE}T15:00:00.000Z`))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('?fim= sozinho devolve os 30 dias que terminam no fim pedido, não 400', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }))
    const res = await chamar(queryMock, '/v1/analytics/assiduidade?fim=2026-03-31')

    expect(res.statusCode).toBe(200)
    expect(res.json().inicio).toBe('2026-03-02')
    expect(res.json().fim).toBe('2026-03-31')
    expect(queryMock.mock.calls[0][1]).toEqual(['2026-03-02', '2026-03-31'])
  })

  it('?inicio= sozinho continua terminando hoje', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }))
    const res = await chamar(queryMock, '/v1/analytics/assiduidade?inicio=2026-09-18')
    expect(res.json().fim).toBe(HOJE)
  })
})
