import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// O cálculo de comissão tem cobertura própria; aqui interessa só o que o apply escreve em lives.
// O mock devolvia { ok: true } onde a função real devolve a LISTA de vendas gravadas.
// Contrato falso: o apply itera esse retorno para saber quais (apresentadora, mês)
// precisam do retro-lift no fim do lote.
vi.mock('../src/services/commission-engine.js', () => ({
  calcularComissoesDaLive: vi.fn(async () => ([
    { apresentadora_id: '55555555-5555-4555-8555-555555555555', data: '2026-05-04' },
  ])),
  aplicarRetroLiftDoMes: vi.fn(async () => {}),
}))

import { analyticsRoutes } from '../src/routes/analytics.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const batchId = '33333333-3333-4333-8333-333333333333'
const rowId = '44444444-4444-4444-8444-444444444444'
const liveId = '55555555-5555-4555-8555-555555555555'

function buildApp(queryMock) {
  const app = Fastify()
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: userId, papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: userId, papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => {
    try { return await fn({ query: queryMock, release }) }
    finally { release() }
  })

  return app
}

function csvBase64() {
  const csv = [
    'MARCA,Start time,,Duration,Attributed GMV,AOV,Attributed orders,Views,LIVE impressions,Product clicks,Avg. viewing duration per viewer,Product impressions,New followers,Likes,Comments,Shares,Ads Cost,Ads GMV',
    'HAAG,46170,0.625,21600,900,100,9,3000,40000,330,27,7000,12,6000,120,8,200,1000',
  ].join('\n')
  return Buffer.from(csv).toString('base64')
}

describe('analytics imports routes', () => {
  it('previews CSV import and persists matched rows for review', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM lives l') && sql.includes('COALESCE(l.agenda_evento_id')) {
        return {
          rows: [{
            live_id: liveId,
            agenda_evento_id: null,
            marca_id: null,
            marca_nome: 'HAAG',
            iniciado_em: '2026-05-28T18:00:00.000Z',
            encerrado_em: '2026-05-29T00:00:00.000Z',
          }],
        }
      }
      if (sql.includes('INSERT INTO analytics_import_batches')) return { rows: [{ id: batchId }] }
      if (sql.includes('INSERT INTO analytics_import_rows')) return { rows: [] }
      throw new Error(`Unexpected SQL: ${sql}`)
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/imports/preview',
      payload: { filename: 'ads.csv', content_base64: csvBase64() },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      batch_id: batchId,
      summary: { total_rows: 1, matched_rows: 1 },
    })
    expect(res.json().rows[0]).toMatchObject({ match_status: 'matched', matched_live_id: liveId, ads_gmv: 1000 })
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO analytics_import_rows'))).toBe(true)

    await app.close()
  })

  it('applies only matched rows to lives ads metrics without changing billing fields', async () => {
    let updateLivesArgs = null
    const normalized = {
      ads_gmv: 1000,
      ads_cost: 200,
      live_impressions: 40000,
      product_impressions: 7000,
      product_clicks: 330,
      avg_viewing_duration: 27,
      new_followers: 12,
      views: 3000,
      comments: 120,
      likes: 6000,
      shares: 8,
      attributed_orders: 9,
    }
    const queryMock = vi.fn(async (sql, args = []) => {
      if (['BEGIN', 'COMMIT'].includes(sql) || sql.includes('SAVEPOINT')) return { rows: [] }
      if (sql.includes('FROM analytics_import_batches') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: batchId, status: 'preview', source_type: 'tiktok_ads', marca_id: null }] }
      }
      if (sql.includes('FROM analytics_import_rows') && sql.includes("decisao IN ('vincular', 'criar')")) {
        return { rows: [{ id: rowId, row_index: 1, matched_live_id: liveId, normalized, decisao: 'vincular', marca_id: null, apresentadoras: null }] }
      }
      if (sql.includes('SELECT id FROM lives WHERE id')) return { rows: [{ id: liveId }], rowCount: 1 }
      if (sql.includes('UPDATE lives')) {
        updateLivesArgs = args
        return { rows: [{ ads_gmv: args[0], gmv_preservado: false }], rowCount: 1 }
      }
      if (sql.includes('UPDATE analytics_import_rows')) return { rows: [] }
      if (sql.includes('UPDATE analytics_import_batches')) return { rows: [] }
      throw new Error(`Unexpected SQL: ${sql}`)
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)

    const res = await app.inject({ method: 'POST', url: `/v1/analytics/imports/${batchId}/apply` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, batch_id: batchId, applied_rows: 1, failed_rows: [] })
    expect(updateLivesArgs.slice(0, 12)).toEqual([1000, 200, 40000, 7000, 330, 27, 12, 3000, 120, 6000, 8, 9])
    const updateSql = queryMock.mock.calls.find(([sql]) => sql.includes('UPDATE lives'))?.[0]
    expect(updateSql).not.toContain('fat_gerado')
    expect(updateSql).not.toContain('comissao_calculada')

    await app.close()
  })

  // O recálculo do mês inteiro (retro-lift do cliff) rodava DENTRO do laço, uma vez por
  // linha da planilha — e cada passada refazia o mês que a anterior acabou de refazer.
  // Era ~91 das ~96 idas ao banco por linha: um lote de 9 linhas levava 177s contra um
  // navegador que desiste aos 15s. Agora roda uma vez por (apresentadora, mês) no fim.
  it('recalcula o mês uma vez por apresentadora, não uma vez por linha', async () => {
    const { calcularComissoesDaLive, aplicarRetroLiftDoMes } = await import('../src/services/commission-engine.js')
    calcularComissoesDaLive.mockClear()
    aplicarRetroLiftDoMes.mockClear()

    const apA = '66666666-6666-4666-8666-666666666666'
    const apB = '77777777-7777-4777-8777-777777777777'
    // 3 linhas: duas da mesma apresentadora no mesmo mês (dedupe), uma de outra.
    const porLinha = {
      1: [{ apresentadora_id: apA, data: '2026-05-04' }],
      2: [{ apresentadora_id: apA, data: '2026-05-19' }],
      3: [{ apresentadora_id: apB, data: '2026-05-07' }],
    }
    let chamada = 0
    calcularComissoesDaLive.mockImplementation(async () => {
      chamada += 1
      return porLinha[chamada] ?? []
    })

    const normalized = { ads_gmv: 500, attributed_orders: 3 }
    const linhas = [1, 2, 3].map((i) => ({
      id: `4444444${i}-4444-4444-8444-44444444444${i}`,
      row_index: i,
      matched_live_id: `5555555${i}-5555-4555-8555-55555555555${i}`,
      normalized,
      decisao: 'vincular',
      marca_id: null,
      apresentadoras: null,
    }))

    const queryMock = vi.fn(async (sql) => {
      if (['BEGIN', 'COMMIT'].includes(sql) || sql.includes('SAVEPOINT')) return { rows: [] }
      if (sql.includes('FROM analytics_import_batches') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: batchId, status: 'preview', source_type: 'tiktok_studio', marca_id: null }] }
      }
      if (sql.includes('FROM analytics_import_rows') && sql.includes("decisao IN ('vincular', 'criar')")) {
        return { rows: linhas }
      }
      if (sql.includes('SELECT id FROM lives WHERE id')) return { rows: [{ id: linhas[0].matched_live_id }], rowCount: 1 }
      if (sql.includes('UPDATE lives')) return { rows: [{ ads_gmv: 500, gmv_preservado: false }], rowCount: 1 }
      if (sql.includes('UPDATE analytics_import_rows')) return { rows: [] }
      if (sql.includes('UPDATE analytics_import_batches')) return { rows: [] }
      throw new Error(`Unexpected SQL: ${sql}`)
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)
    const res = await app.inject({ method: 'POST', url: `/v1/analytics/imports/${batchId}/apply` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, applied_rows: 3, failed_rows: [] })

    // Nenhuma linha pode disparar o recálculo do mês por conta própria.
    for (const [, opts] of calcularComissoesDaLive.mock.calls) {
      expect(opts.retroLift).toBe(false)
    }
    // 3 linhas, 2 pares (apresentadora, mês) — não 3 chamadas.
    expect(aplicarRetroLiftDoMes).toHaveBeenCalledTimes(2)
    const pares = aplicarRetroLiftDoMes.mock.calls.map(([, o]) => `${o.apresentadoraId}|${o.mes}`).sort()
    expect(pares).toEqual([`${apA}|2026-05`, `${apB}|2026-05`])

    await app.close()
  })
  // GMV corrigido à mão numa live importada não pode ser apagado por uma reimportação: é o
  // mesmo "editei e voltou sozinho" que já custou 3 lives em produção. A prova de correção
  // manual é a linha em live_metric_revisions com campo='ads_gmv' — essa tabela só é escrita
  // pelo PATCH da live, nunca por este import.
  it('não sobrescreve o GMV corrigido à mão e diz quantas lives preservou', async () => {
    const { calcularComissoesDaLive } = await import('../src/services/commission-engine.js')
    calcularComissoesDaLive.mockClear()
    calcularComissoesDaLive.mockImplementation(async () => ([]))

    let updateSql = null
    const normalized = { ads_gmv: 1000, attributed_orders: 9 }
    const queryMock = vi.fn(async (sql) => {
      if (['BEGIN', 'COMMIT'].includes(sql) || sql.includes('SAVEPOINT')) return { rows: [] }
      if (sql.includes('FROM analytics_import_batches') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: batchId, status: 'preview', source_type: 'tiktok_studio', marca_id: null }] }
      }
      if (sql.includes('FROM analytics_import_rows') && sql.includes("decisao IN ('vincular', 'criar')")) {
        return { rows: [{ id: rowId, row_index: 1, matched_live_id: liveId, normalized, decisao: 'vincular', marca_id: null, apresentadoras: null }] }
      }
      if (sql.includes('SELECT id FROM lives WHERE id')) return { rows: [{ id: liveId }], rowCount: 1 }
      if (sql.includes('UPDATE lives')) {
        updateSql = sql
        // A live já tinha correção manual: o banco devolve o valor ANTIGO, não o da planilha.
        return { rows: [{ ads_gmv: '2419.00', gmv_preservado: true }], rowCount: 1 }
      }
      if (sql.includes('UPDATE analytics_import_rows')) return { rows: [] }
      if (sql.includes('UPDATE analytics_import_batches')) return { rows: [] }
      throw new Error(`Unexpected SQL: ${sql}`)
    })

    const app = buildApp(queryMock)
    await app.register(analyticsRoutes)
    const res = await app.inject({ method: 'POST', url: `/v1/analytics/imports/${batchId}/apply` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, applied_rows: 1, gmv_preservado_rows: 1 })
    expect(updateSql).toContain('live_metric_revisions')
    expect(updateSql).toContain("r.campo = 'ads_gmv'")
    // A comissão tem que usar o GMV que FICOU gravado, não o da planilha — senão o dinheiro
    // pago diverge do número que a tela mostra.
    expect(calcularComissoesDaLive.mock.calls[0][1].gmv).toBe(2419)

    await app.close()
  })
})
