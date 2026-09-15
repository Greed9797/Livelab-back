import { describe, expect, it } from 'vitest'

import {
  buildLiveMergePreview,
  isLiveMergeEnabled,
  stableLiveMergeHash,
} from '../src/lib/live-merge.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const cabineId = '22222222-2222-4222-8222-222222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'
const clienteId = '44444444-4444-4444-8444-444444444444'
const gestorId = '55555555-5555-4555-8555-555555555555'
const anaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const biaId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function source(id, start, end, presenter, gmv, orders, overrides = {}) {
  const seconds = Number(end) - Number(start)
  return {
    id,
    tenant_id: tenantId,
    cabine_id: cabineId,
    cabine_numero: 1,
    cliente_id: clienteId,
    gestor_id: gestorId,
    marca_id: marcaId,
    marca_nome: 'Marca',
    tipo: 'cliente',
    status: 'encerrada',
    status_publicacao: 'publicado',
    iniciado_em: `2026-09-15T${start === '1000' ? '12:00' : '13:00'}:00.000Z`,
    encerrado_em: `2026-09-15T${end === '4600' ? '13:00' : '14:00'}:00.000Z`,
    iniciado_epoch: start,
    encerrado_epoch: end,
    inicio_dia_sp: '2026-09-15',
    fim_dia_sp: '2026-09-15',
    fat_gerado: String(gmv),
    manual_gmv: String(gmv),
    ads_gmv: null,
    final_orders_count: orders,
    manual_orders: orders,
    live_impressions: 100,
    manual_views: 200,
    manual_likes: 10,
    manual_comments: 5,
    manual_shares: 2,
    manual_diamonds: 1,
    ads_cost: '20.00',
    product_impressions: 50,
    product_clicks: 10,
    avg_viewing_duration: null,
    new_followers: 3,
    final_peak_viewers: 80,
    faturado_em: null,
    boleto_id: null,
    uniao_destino_id: null,
    uniao_id: null,
    uniao_desfeita_em: null,
    apresentadoras: [{
      apresentadora_id: presenter.id,
      nome: presenter.nome,
      user_id: presenter.userId,
      papel: 'principal',
      gmv_rateado: String(gmv),
      segundos_rateio: seconds,
      pedidos_rateados: orders,
    }],
    vendas: [{
      id: `9${id.slice(1)}`,
      tenant_id: tenantId,
      origem: 'live',
      origem_id: id,
      marca_id: marcaId,
      apresentadora_id: presenter.id,
      apresentadora_nome: presenter.nome,
      apresentadora_user_id: presenter.userId,
      data: '2026-09-15',
      gmv: String(gmv),
      pedidos: orders,
      comissao_apresentadora: '100.00',
      comissao_franquia: '200.00',
      comissao_franqueadora: '50.00',
      status_aprovacao: 'pendente_aprovacao',
      status_motivo: null,
      aprovado_por: null,
      aprovado_em: null,
      criado_em: '2026-09-15T15:00:00.000Z',
      atualizado_em: '2026-09-15T15:00:00.000Z',
    }],
    ...overrides,
  }
}

const ana = { id: anaId, nome: 'Ana', userId: '55555555-5555-4555-8555-555555555555' }
const bia = { id: biaId, nome: 'Bia', userId: '66666666-6666-4666-8666-666666666666' }
const liveA = '77777777-7777-4777-8777-777777777777'
const liveB = '88888888-8888-4888-8888-888888888888'

describe('buildLiveMergePreview', () => {
  it('consolida métricas e mantém GMV, pedidos e horas de cada apresentadora', () => {
    const preview = buildLiveMergePreview([
      source(liveB, '4600', '8200', bia, 3000, 30),
      source(liveA, '1000', '4600', ana, 2000, 20),
    ])

    expect(preview.eligible).toBe(true)
    expect(preview.blockers).toEqual([])
    expect(preview.origens.map((item) => item.live_id)).toEqual([liveA, liveB])
    expect(preview.totais).toMatchObject({
      gmv: 5000,
      pedidos: 50,
      segundos: 7200,
      live_impressions: 200,
      manual_views: 400,
      comissao_apresentadora: 200,
      comissao_franquia: 400,
      comissao_franqueadora: 100,
    })
    expect(preview.apresentadoras).toEqual([
      { apresentadora_id: anaId, nome: 'Ana', user_id: ana.userId, gmv: 2000, segundos: 3600, pedidos: 20 },
      { apresentadora_id: biaId, nome: 'Bia', user_id: bia.userId, gmv: 3000, segundos: 3600, pedidos: 30 },
    ])
    expect(preview.preview_token).toMatch(/^lm1:[a-f0-9]{64}$/)
  })

  it('mantém métrica agregada nula quando qualquer trecho não a possui', () => {
    const second = source(liveB, '4600', '8200', bia, 3000, 30, { manual_views: null })
    const preview = buildLiveMergePreview([source(liveA, '1000', '4600', ana, 2000, 20), second])
    expect(preview.eligible).toBe(true)
    expect(preview.totais.manual_views).toBeNull()
    expect(preview.warnings).toContain('Visualizações: subtotal conhecido 200; faltam dados em 1 trecho. Total permanece pendente.')
  })

  it.each([
    ['DIFFERENT_BRAND', { marca_id: '99999999-9999-4999-8999-999999999999' }],
    ['DIFFERENT_MANAGER', { gestor_id: '99999999-9999-4999-8999-999999999999' }],
    ['NOT_CONTIGUOUS', { iniciado_epoch: '4600.000001' }],
    ['FINANCIAL_LINK_EXISTS', { boleto_id: '99999999-9999-4999-8999-999999999999' }],
    ['ALREADY_MERGED', { uniao_destino_id: liveA }],
  ])('bloqueia %s', (code, override) => {
    const preview = buildLiveMergePreview([
      source(liveA, '1000', '4600', ana, 2000, 20),
      source(liveB, '4600', '8200', bia, 3000, 30, override),
    ])
    expect(preview.eligible).toBe(false)
    expect(preview.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code })]))
  })

  it('bloqueia rateio múltiplo sem valores e duração absolutos completos', () => {
    const first = source(liveA, '1000', '4600', ana, 2000, 20)
    first.apresentadoras.push({
      apresentadora_id: biaId,
      nome: 'Bia',
      user_id: bia.userId,
      papel: 'apoio',
      gmv_rateado: null,
      segundos_rateio: null,
      pedidos_rateados: null,
    })
    first.vendas.push({ ...first.vendas[0], id: '99999999-9999-4999-8999-999999999999', apresentadora_id: biaId, gmv: '0', pedidos: 0 })

    const preview = buildLiveMergePreview([first, source(liveB, '4600', '8200', bia, 3000, 30)])
    expect(preview.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INCOMPLETE_PRESENTER_SPLIT', live_id: liveA }),
    ]))
  })

  it('bloqueia vendas ausentes ou divergentes do valor oficial da live', () => {
    const first = source(liveA, '1000', '4600', ana, 2000, 20)
    first.vendas[0].gmv = '1999.99'
    const preview = buildLiveMergePreview([first, source(liveB, '4600', '8200', bia, 3000, 30)])
    expect(preview.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ATTRIBUTED_SALES_MISMATCH', live_id: liveA }),
    ]))
  })

  it('aceita lives oficiais encerradas em rascunho quando o estado é o mesmo', () => {
    const preview = buildLiveMergePreview([
      source(liveA, '1000', '4600', ana, 2000, 20, { status_publicacao: 'rascunho' }),
      source(liveB, '4600', '8200', bia, 3000, 30, { status_publicacao: 'rascunho' }),
    ])
    expect(preview.eligible).toBe(true)
  })

  it('bloqueia tempo individual negativo mesmo quando a soma do rateio fecha', () => {
    const first = source(liveA, '1000', '4600', ana, 2000, 20)
    first.apresentadoras = [
      { ...first.apresentadoras[0], gmv_rateado: '2000', segundos_rateio: -1 },
      { apresentadora_id: biaId, nome: 'Bia', user_id: bia.userId, papel: 'apoio', gmv_rateado: '0', segundos_rateio: 3601 },
    ]
    first.vendas.push({ ...first.vendas[0], id: '99999999-9999-4999-8999-999999999999', apresentadora_id: biaId, gmv: '0', pedidos: 0 })
    const preview = buildLiveMergePreview([first, source(liveB, '4600', '8200', bia, 3000, 30)])
    expect(preview.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INCOMPLETE_PRESENTER_SPLIT', live_id: liveA }),
    ]))
  })

  it.each([
    ['INVALID_METRIC', { ads_cost: '-0.01' }],
    ['DIFFERENT_ROOM', { tiktok_room_id: 'room-b' }],
    ['OPERATIONAL_REVIEW_REQUIRED', { status_operacional: 'atencao', problema: 'Conferir dados importados' }],
  ])('bloqueia %s em dados de origem', (code, override) => {
    const preview = buildLiveMergePreview([
      source(liveA, '1000', '4600', ana, 2000, 20, { tiktok_room_id: 'room-a' }),
      source(liveB, '4600', '8200', bia, 3000, 30, override),
    ])
    expect(preview.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code })]))
  })

  it('inclui dados financeiros no token de versão', () => {
    const sources = [source(liveA, '1000', '4600', ana, 2000, 20), source(liveB, '4600', '8200', bia, 3000, 30)]
    const before = stableLiveMergeHash(sources)
    sources[0].vendas[0].comissao_apresentadora = '100.01'
    expect(stableLiveMergeHash(sources)).not.toBe(before)
  })
})

describe('isLiveMergeEnabled', () => {
  it('mantém desativado sem configuração e permite uma lista explícita', () => {
    expect(isLiveMergeEnabled(tenantId, {})).toBe(false)
    expect(isLiveMergeEnabled(tenantId, { LIVE_MERGE_TENANT_ALLOWLIST: tenantId })).toBe(true)
    expect(isLiveMergeEnabled(tenantId, { LIVE_MERGE_TENANT_ALLOWLIST: '' })).toBe(false)
    expect(isLiveMergeEnabled(tenantId, { LIVE_MERGE_TENANT_ALLOWLIST: marcaId })).toBe(false)
  })
  it('permite ativação global explícita sem aceitar tenant ausente ou inválido', () => {
    expect(isLiveMergeEnabled(tenantId, { LIVE_MERGE_TENANT_ALLOWLIST: '*' })).toBe(true)
    expect(isLiveMergeEnabled(tenantId, { LIVE_MERGE_TENANT_ALLOWLIST: ' * ' })).toBe(true)
    expect(isLiveMergeEnabled('', { LIVE_MERGE_TENANT_ALLOWLIST: '*' })).toBe(false)
    expect(isLiveMergeEnabled('invalid', { LIVE_MERGE_TENANT_ALLOWLIST: '*' })).toBe(false)
    expect(isLiveMergeEnabled(tenantId, { LIVE_MERGE_TENANT_ALLOWLIST: 'off' })).toBe(false)
  })
})
