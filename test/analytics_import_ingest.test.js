import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// A comissão tem cobertura própria; aqui interessa o que a entrada de máquina
// decide aplicar e o que ela recusa a decidir sozinha.
vi.mock('../src/services/commission-engine.js', () => ({
  calcularComissoesDaLive: vi.fn(async () => ([
    { apresentadora_id: '55555555-5555-4555-8555-555555555555', data: '2026-05-04' },
  ])),
  aplicarRetroLiftDoMes: vi.fn(async () => {}),
}))

import { analyticsRoutes } from '../src/routes/analytics.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const keyId = '66666666-6666-4666-8666-666666666666'
const batchId = '33333333-3333-4333-8333-333333333333'
const liveId = '55555555-5555-4555-8555-555555555555'

function buildApp(queryMock) {
  const app = Fastify()
  const release = vi.fn()
  // Quem chama é uma chave de API: o `sub` é sintético e o id da chave é que
  // vai para as colunas de autoria.
  const comoChave = (request) => {
    request.user = { tenant_id: tenantId, sub: `apikey:${keyId}`, papel: 'automacao' }
    request.viaApiKey = { id: keyId, nome: 'grok bot' }
  }
  app.decorate('authenticate', async (request) => { comoChave(request) })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) comoChave(request)
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => {
    try { return await fn({ query: queryMock, release }) }
    finally { release() }
  })
  return app
}

/** Duas lives no arquivo: a primeira casa com folga, a segunda não casa com nada. */
function csvBase64() {
  const csv = [
    'MARCA,Start time,,Duration,Attributed GMV,AOV,Attributed orders,Views,LIVE impressions,Product clicks,Avg. viewing duration per viewer,Product impressions,New followers,Likes,Comments,Shares,Ads Cost,Ads GMV',
    'HAAG,46170,0.625,21600,900,100,9,3000,40000,330,27,7000,12,6000,120,8,200,1000',
    'HAAG,46171,0.625,21600,500,100,5,3000,40000,330,27,7000,12,6000,120,8,200,700',
  ].join('\n')
  return Buffer.from(csv).toString('base64')
}

/** Uma live candidata que cobre exatamente a janela da primeira linha do CSV. */
const candidata = {
  live_id: liveId,
  agenda_evento_id: null,
  marca_id: null,
  marca_nome: 'HAAG',
  iniciado_em: '2026-05-28T18:00:00.000Z',
  encerrado_em: '2026-05-29T00:00:00.000Z',
}

function queryPadrao({ duplicado = false, linhasAplicaveis } = {}) {
  return vi.fn(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
    if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE') || sql.startsWith('ROLLBACK TO')) return { rows: [] }

    if (sql.includes('file_hash = $2')) {
      return duplicado
        ? { rowCount: 1, rows: [{ id: batchId, applied_rows: 2 }] }
        : { rowCount: 0, rows: [] }
    }
    if (sql.includes('FROM lives l') && sql.includes('COALESCE(l.agenda_evento_id')) {
      return { rows: [candidata] }
    }
    if (sql.includes('INSERT INTO analytics_import_batches')) return { rows: [{ id: batchId }] }
    if (sql.includes('INSERT INTO analytics_import_rows')) return { rows: [{ id: 'row-1' }] }
    if (sql.includes('FROM analytics_import_batches') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: batchId, status: 'preview', source_type: 'tiktok_ads', marca_id: null, apresentadora_id: null }] }
    }
    if (sql.includes('FROM analytics_import_rows') && sql.includes('FOR UPDATE')) {
      return { rows: linhasAplicaveis ?? [] }
    }
    // resolveTargetLive confere que a live escolhida é mesmo do tenant.
    if (sql.includes('SELECT id FROM lives WHERE id')) return { rows: [{ id: liveId }] }
    if (sql.includes('UPDATE analytics_import_rows')) return { rows: [] }
    if (sql.includes('UPDATE analytics_import_batches')) return { rows: [] }
    if (sql.includes('UPDATE lives')) {
      return { rows: [{ ads_gmv: '1000', gmv_preservado: false }] }
    }
    if (sql.includes('FROM live_apresentadoras_v2') || sql.includes('live_apresentadoras_v2')) return { rows: [] }
    if (sql.includes('vendas_atribuidas')) return { rows: [] }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
}

describe('POST /v1/analytics/imports/ingest', () => {
  it('aplica a linha que casou com folga e deixa a duvidosa pendente para revisão', async () => {
    const queryMock = queryPadrao({
      linhasAplicaveis: [{
        id: 'row-1',
        row_index: 1,
        matched_live_id: liveId,
        normalized: { live_date: '2026-05-28', duration_seconds: 21600, ads_gmv: 1000, attributed_orders: 9 },
        decisao: 'vincular',
        marca_id: null,
        apresentadoras: null,
        cabine_id: null,
      }],
    })
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/imports/ingest',
      payload: { filename: 'tiktok.csv', content_base64: csvBase64() },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.duplicado).toBe(false)
    expect(body.applied_rows).toBe(1)
    // A segunda linha do arquivo não tinha live candidata: sem `criar_lives`, ela
    // não vira live nova nem some — fica nomeada para alguém decidir.
    expect(body.pendentes).toHaveLength(1)
    expect(body.pendentes[0].row_index).toBe(2)

    // A autoria gravada é o id da chave, não a string `apikey:<uuid>`, que não
    // entraria numa coluna UUID.
    const insertLote = queryMock.mock.calls.find(([s]) => s.includes('INSERT INTO analytics_import_batches'))
    expect(insertLote[1]).toContain(keyId)
    expect(insertLote[1].some((p) => String(p).startsWith('apikey:'))).toBe(false)

    // A entrada de máquina passa pelo mesmo UPDATE da tela, então o GMV
    // corrigido à mão continua vencendo a planilha também aqui.
    const updateLive = queryMock.mock.calls.find(([s]) => s.includes('UPDATE lives'))
    expect(updateLive[0]).toContain('live_metric_revisions')
    expect(updateLive[0]).toContain("campo = 'ads_gmv'")
  })

  it('grava o hash do arquivo e devolve o lote anterior quando o mesmo arquivo volta', async () => {
    const queryMock = queryPadrao({ duplicado: true })
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/imports/ingest',
      payload: { filename: 'tiktok.csv', content_base64: csvBase64() },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, duplicado: true, batch_id: batchId })
    // O ponto: reenviar não escreve nada.
    expect(queryMock.mock.calls.some(([s]) => s.includes('INSERT INTO analytics_import_batches'))).toBe(false)
    expect(queryMock.mock.calls.some(([s]) => s.includes('UPDATE lives'))).toBe(false)
  })

  it('recusa arquivo maior que o teto da rota em vez de estourar no meio', async () => {
    const linhas = ['MARCA,Start time,,Duration,Attributed GMV,AOV,Attributed orders,Views,LIVE impressions,Product clicks,Avg. viewing duration per viewer,Product impressions,New followers,Likes,Comments,Shares,Ads Cost,Ads GMV']
    for (let i = 0; i < 1001; i++) {
      linhas.push('HAAG,46170,0.625,21600,900,100,9,3000,40000,330,27,7000,12,6000,120,8,200,1000')
    }
    const queryMock = queryPadrao({})
    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/imports/ingest',
      payload: { filename: 'grande.csv', content_base64: Buffer.from(linhas.join('\n')).toString('base64') },
    })

    expect(res.statusCode).toBe(413)
    expect(res.json().error).toMatch(/Divida o arquivo/)
    // Nada foi gravado antes da recusa.
    expect(queryMock.mock.calls.some(([s]) => s.includes('INSERT'))).toBe(false)
  })
})
