import { describe, expect, it, vi } from 'vitest'

import { mergeLives, undoLiveMerge } from '../src/services/live-merge.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveA = '77777777-7777-4777-8777-777777777777'
const liveB = '88888888-8888-4888-8888-888888888888'
const unionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const destinationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function dbFixture() {
  const calls = []
  const lives = [
    {
      id: liveA, tenant_id: tenantId, cabine_id: '22222222-2222-4222-8222-222222222222', cabine_numero: 1,
      cliente_id: '44444444-4444-4444-8444-444444444444', marca_id: '33333333-3333-4333-8333-333333333333', marca_nome: 'Marca', tipo: 'cliente', status: 'encerrada', status_publicacao: 'publicado', origem_dados: 'manual',
      iniciado_em: '2026-09-15T12:00:00.000Z', encerrado_em: '2026-09-15T13:00:00.000Z', iniciado_epoch: '1000', encerrado_epoch: '4600', inicio_dia_sp: '2026-09-15', fim_dia_sp: '2026-09-15',
      fat_gerado: '2000', manual_gmv: '2000', ads_gmv: null, final_orders_count: 20, manual_orders: 20,
      live_impressions: 100, manual_views: 200, manual_likes: 10, manual_comments: 5, manual_shares: 2, manual_diamonds: 1,
      ads_cost: '20', product_impressions: 50, product_clicks: 10, avg_viewing_duration: null, new_followers: 3, final_peak_viewers: 80,
      faturado_em: null, boleto_id: null, uniao_destino_id: null, uniao_id: null, uniao_desfeita_em: null,
    },
    {
      id: liveB, tenant_id: tenantId, cabine_id: '22222222-2222-4222-8222-222222222222', cabine_numero: 1,
      cliente_id: '44444444-4444-4444-8444-444444444444', marca_id: '33333333-3333-4333-8333-333333333333', marca_nome: 'Marca', tipo: 'cliente', status: 'encerrada', status_publicacao: 'publicado', origem_dados: 'manual',
      iniciado_em: '2026-09-15T13:00:00.000Z', encerrado_em: '2026-09-15T14:00:00.000Z', iniciado_epoch: '4600', encerrado_epoch: '8200', inicio_dia_sp: '2026-09-15', fim_dia_sp: '2026-09-15',
      fat_gerado: '3000', manual_gmv: '3000', ads_gmv: null, final_orders_count: 30, manual_orders: 30,
      live_impressions: 100, manual_views: 200, manual_likes: 10, manual_comments: 5, manual_shares: 2, manual_diamonds: 1,
      ads_cost: '20', product_impressions: 50, product_clicks: 10, avg_viewing_duration: null, new_followers: 3, final_peak_viewers: 80,
      faturado_em: null, boleto_id: null, uniao_destino_id: null, uniao_id: null, uniao_desfeita_em: null,
    },
  ]
  const rateios = [
    { live_id: liveA, apresentadora_id: '55555555-5555-4555-8555-555555555555', nome: 'Ana', user_id: '11111111-2222-4222-8222-111111111111', papel: 'principal', gmv_rateado: '2000', segundos_rateio: 3600, pedidos_rateados: 20 },
    { live_id: liveB, apresentadora_id: '66666666-6666-4666-8666-666666666666', nome: 'Bia', user_id: '22222222-3333-4333-8333-222222222222', papel: 'principal', gmv_rateado: '3000', segundos_rateio: 3600, pedidos_rateados: 30 },
  ]
  const sales = [
    { id: '12121212-1212-4212-8212-121212121212', tenant_id: tenantId, origem: 'live', origem_id: liveA, marca_id: '33333333-3333-4333-8333-333333333333', apresentadora_id: rateios[0].apresentadora_id, apresentadora_nome: 'Ana', apresentadora_user_id: rateios[0].user_id, data: '2026-09-15', gmv: '2000', pedidos: 20, comissao_apresentadora: '100', comissao_franquia: '200', comissao_franqueadora: '50', status_aprovacao: 'pendente_aprovacao', status_motivo: null, aprovado_por: null, aprovado_em: null, criado_em: '2026-09-15T15:00:00Z', atualizado_em: '2026-09-15T15:00:00Z' },
    { id: '13131313-1313-4313-8313-131313131313', tenant_id: tenantId, origem: 'live', origem_id: liveB, marca_id: '33333333-3333-4333-8333-333333333333', apresentadora_id: rateios[1].apresentadora_id, apresentadora_nome: 'Bia', apresentadora_user_id: rateios[1].user_id, data: '2026-09-15', gmv: '3000', pedidos: 30, comissao_apresentadora: '150', comissao_franquia: '300', comissao_franqueadora: '75', status_aprovacao: 'pendente_aprovacao', status_motivo: null, aprovado_por: null, aprovado_em: null, criado_em: '2026-09-15T15:00:00Z', atualizado_em: '2026-09-15T15:00:00Z' },
  ]
  const persistedDestination = {
    id: destinationId, fat_gerado: '5000.00', manual_gmv: '5000.00',
    manual_orders: 50, final_orders_count: 50, comissao_calculada: '500.00',
    comissao_apresentadora_valor: '250.00', faturado_em: null, boleto_id: null,
    uniao_id: unionId, uniao_desfeita_em: null,
  }
  const persistedSales = sales.map((sale) => ({
    marca_id: sale.marca_id, apresentadora_id: sale.apresentadora_id, data: sale.data,
    gmv: sale.gmv, pedidos: sale.pedidos,
    comissao_apresentadora: sale.comissao_apresentadora,
    comissao_franquia: sale.comissao_franquia,
    comissao_franqueadora: sale.comissao_franqueadora,
    status_aprovacao: 'pendente_aprovacao', status_motivo: null,
    aprovado_por: null, aprovado_em: null,
  }))
  const query = vi.fn(async (sql, params = []) => {
    const text = String(sql)
    calls.push({ sql: text, params })
    if (text.includes('live-merge:idempotency-lock')) return { rows: [] }
    if (text.includes('live-merge:existing-request')) return { rows: [] }
    if (text.includes('live-merge:load-lives')) return { rows: lives }
    if (text.includes('live-merge:load-rateio')) return { rows: rateios }
    if (text.includes('live-merge:load-sales')) return { rows: sales }
    if (text.includes('live-merge:insert-destination')) return { rows: [{ id: destinationId }] }
    if (text.includes('live-merge:read-destination-financial')) return { rows: [persistedDestination] }
    if (text.includes('live-merge:read-destination-sales')) return { rows: persistedSales }
    return { rows: [], rowCount: 1 }
  })
  return { db: { query }, calls, lives, rateios, sales }
}

describe('mergeLives transaction', () => {
  it('trava fontes, ativa bypass e substitui vendas preservando os valores financeiros', async () => {
    const { db, calls } = dbFixture()
    const previewModule = await import('../src/lib/live-merge.js')
    const loaded = await previewModule.buildLiveMergePreview // keeps module explicit for coverage
    void loaded
    // Token is recomputed from the same fixture inside the transaction. Preview once using the service loader.
    const { previewLiveMerge } = await import('../src/services/live-merge.js')
    const preview = await previewLiveMerge(db, { tenantId, liveIds: [liveA, liveB] })
    calls.length = 0

    const result = await mergeLives(db, {
      tenantId,
      userId: '99999999-9999-4999-8999-999999999999',
      liveIds: [liveA, liveB],
      previewToken: preview.preview_token,
      requestId: '14141414-1414-4414-8414-141414141414',
      motivo: 'Troca de apresentadora',
      metricasPorTrecho: true,
      uuidFactory: (() => {
        const ids = [unionId, destinationId]
        return () => ids.shift()
      })(),
    })

    expect(result).toEqual({ live_id: destinationId, uniao_id: unionId })
    const sqls = calls.map((call) => call.sql)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toContain('live-finance:tenant-lock')
    expect(calls[1].params).toEqual([tenantId])
    expect(sqls[2]).toContain("set_config('livelab.live_merge_write', 'on', true)")
    expect(sqls[3]).toContain('live-merge:idempotency-lock')
    expect(sqls.find((sql) => sql.includes('live-merge:load-lives'))).toContain('FOR UPDATE')
    expect(sqls).toEqual(expect.arrayContaining([
      expect.stringContaining('live-merge:delete-source-sales'),
      expect.stringContaining('live-merge:insert-destination-sale'),
      expect.stringContaining('live-merge:mark-sources'),
      expect.stringContaining('live-merge:insert-union'),
    ]))
    expect(sqls.at(-1)).toBe('COMMIT')

    const saleInserts = calls.filter((call) => call.sql.includes('live-merge:insert-destination-sale'))
    expect(saleInserts).toHaveLength(2)
    expect(saleInserts.map((call) => call.params.slice(5, 10))).toEqual([
      ['2000.00', 20, '100.00', '200.00', '50.00'],
      ['3000.00', 30, '150.00', '300.00', '75.00'],
    ])
  })

  it('faz rollback quando a prévia ficou obsoleta', async () => {
    const { db, calls } = dbFixture()
    await expect(mergeLives(db, {
      tenantId,
      userId: null,
      liveIds: [liveA, liveB],
      previewToken: 'lm1:stale',
      requestId: '14141414-1414-4414-8414-141414141414',
      motivo: null,
      metricasPorTrecho: true,
    })).rejects.toMatchObject({ code: 'PREVIEW_STALE', statusCode: 409 })
    expect(calls.map((call) => call.sql).at(-1)).toBe('ROLLBACK')
    expect(calls.some((call) => call.sql.includes('live-merge:insert-destination'))).toBe(false)
  })
})

describe('undoLiveMerge transaction', () => {
  async function mergedSnapshot() {
    const fixture = dbFixture()
    const { previewLiveMerge } = await import('../src/services/live-merge.js')
    const preview = await previewLiveMerge(fixture.db, { tenantId, liveIds: [liveA, liveB] })
    fixture.calls.length = 0
    await mergeLives(fixture.db, {
      tenantId,
      userId: '99999999-9999-4999-8999-999999999999',
      liveIds: [liveA, liveB],
      previewToken: preview.preview_token,
      requestId: '14141414-1414-4414-8414-141414141414',
      motivo: 'Troca de apresentadora',
      metricasPorTrecho: true,
      uuidFactory: (() => {
        const ids = [unionId, destinationId]
        return () => ids.shift()
      })(),
    })
    const insertUnion = fixture.calls.find((call) => call.sql.includes('live-merge:insert-union'))
    return {
      union: {
        id: unionId,
        live_destino_id: destinationId,
        origens: JSON.parse(insertUnion.params[6]),
        resultado: JSON.parse(insertUnion.params[7]),
        desfeito_em: null,
        desfeito_request_id: null,
      },
      destination: {
        id: destinationId,
        fat_gerado: '5000.00',
        manual_gmv: '5000.00',
        manual_orders: 50,
        final_orders_count: 50,
        comissao_calculada: '500.00',
        comissao_apresentadora_valor: '250.00',
        faturado_em: null,
        boleto_id: null,
        uniao_id: unionId,
        uniao_desfeita_em: null,
      },
      destinationSales: fixture.sales.map((sale) => ({
        ...sale,
        origem_id: destinationId,
        criado_em: '2026-09-15T16:00:00Z',
        atualizado_em: '2026-09-15T16:00:00Z',
      })),
    }
  }

  it('restaura as vendas originais e mantém a consolidada como histórico desfeito', async () => {
    const state = await mergedSnapshot()
    const calls = []
    const query = vi.fn(async (sql, params = []) => {
      const text = String(sql)
      calls.push({ sql: text, params })
      if (text.includes('live-merge:load-union')) return { rows: [state.union] }
      if (text.includes('live-merge:lock-destination-sales')) return { rows: state.destinationSales }
      if (text.includes('live-merge:lock-destination')) return { rows: [state.destination] }
      if (text.includes('live-merge:lock-sources')) return { rows: [
        { id: liveA, uniao_destino_id: destinationId },
        { id: liveB, uniao_destino_id: destinationId },
      ] }
      return { rows: [], rowCount: 1 }
    })

    const result = await undoLiveMerge({ query }, {
      tenantId,
      userId: '99999999-9999-4999-8999-999999999999',
      unionId,
      requestId: '15151515-1515-4515-8515-151515151515',
      motivo: 'Cadastro corrigido',
    })
    expect(result).toEqual({ live_ids: [liveA, liveB] })
    const sqls = calls.map((call) => call.sql)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toContain('live-finance:tenant-lock')
    expect(calls[1].params).toEqual([tenantId])
    expect(sqls[2]).toContain("set_config('livelab.live_merge_write', 'on', true)")
    expect(sqls[3]).toContain('live-merge:idempotency-lock')
    expect(sqls[4]).toContain('live-merge:load-union')
    expect(sqls.filter((sql) => sql.includes('live-merge:restore-source-sale'))).toHaveLength(2)
    expect(sqls).toEqual(expect.arrayContaining([
      expect.stringContaining('live-merge:delete-destination-sales'),
      expect.stringContaining('live-merge:unmark-sources'),
      expect.stringContaining('live-merge:mark-destination-undone'),
      expect.stringContaining('live-merge:mark-union-undone'),
    ]))
    expect(sqls.at(-1)).toBe('COMMIT')
  })

  it('bloqueia reversão se uma comissão mudou depois da união', async () => {
    const state = await mergedSnapshot()
    state.destinationSales[0].comissao_apresentadora = '100.01'
    const calls = []
    const query = vi.fn(async (sql, params = []) => {
      const text = String(sql)
      calls.push({ sql: text, params })
      if (text.includes('live-merge:load-union')) return { rows: [state.union] }
      if (text.includes('live-merge:lock-destination-sales')) return { rows: state.destinationSales }
      if (text.includes('live-merge:lock-destination')) return { rows: [state.destination] }
      if (text.includes('live-merge:lock-sources')) return { rows: [
        { id: liveA, uniao_destino_id: destinationId },
        { id: liveB, uniao_destino_id: destinationId },
      ] }
      return { rows: [], rowCount: 1 }
    })
    await expect(undoLiveMerge({ query }, {
      tenantId,
      userId: null,
      unionId,
      requestId: '15151515-1515-4515-8515-151515151515',
      motivo: 'Cadastro corrigido',
    })).rejects.toMatchObject({ code: 'UNION_FINANCE_CHANGED', statusCode: 409 })
    expect(calls.map((call) => call.sql).at(-1)).toBe('ROLLBACK')
  })
})
