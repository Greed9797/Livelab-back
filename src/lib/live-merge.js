import { createHash } from 'node:crypto'

const DAY_SECONDS = 24 * 60 * 60
const MAX_INTEGER = 2_147_483_647
const MAX_MANUAL_GMV_CENTS = 999_999_999_999n
const MAX_NUMERIC_15_CENTS = 999_999_999_999_999n

function canonical(value) {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

function decimalToCents(value) {
  const raw = String(value ?? 0).trim()
  const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?$/)
  if (!match) return null
  const fraction = (match[3] ?? '').padEnd(3, '0')
  let cents = BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2) || '0')
  if (Number(fraction[2] ?? 0) >= 5) cents += 1n
  return match[1] ? -cents : cents
}

function centsToNumber(cents) {
  if (cents === null || !Number.isSafeInteger(Number(cents))) return null
  return Number(cents) / 100
}

export function centsToDecimal(cents) {
  const negative = cents < 0n
  const absolute = negative ? -cents : cents
  const whole = absolute / 100n
  const fraction = String(absolute % 100n).padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

function sumMoney(values) {
  let total = 0n
  for (const value of values) {
    const cents = decimalToCents(value)
    if (cents === null) return null
    total += cents
  }
  return total
}

export function sumMoneyDecimal(values) {
  const total = sumMoney(values)
  return total === null ? null : centsToDecimal(total)
}

function epochMicros(value) {
  const match = String(value ?? '').match(/^(\d+)(?:\.(\d{1,6}))?$/)
  if (!match) return null
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'))
}

function nullableSum(rows, field) {
  if (rows.some((row) => row[field] === null || row[field] === undefined)) return null
  const total = rows.reduce((sum, row) => sum + Number(row[field]), 0)
  return Number.isSafeInteger(total) ? total : null
}

function nullableMoneySum(rows, field) {
  if (rows.some((row) => row[field] === null || row[field] === undefined)) return null
  return centsToNumber(sumMoney(rows.map((row) => row[field])))
}

function firstDefined(row, fields) {
  for (const field of fields) {
    if (row[field] !== null && row[field] !== undefined) return row[field]
  }
  return null
}

function officialGmvCents(live) {
  return decimalToCents(firstDefined(live, ['ads_gmv', 'manual_gmv', 'fat_gerado']))
}

function officialOrders(live) {
  const value = firstDefined(live, ['manual_orders', 'final_orders_count'])
  return value === null ? null : Number(value)
}

function addBlocker(blockers, code, message, liveId) {
  const blocker = { code, message }
  if (liveId) blocker.live_id = liveId
  if (!blockers.some((item) => item.code === code && item.live_id === liveId)) blockers.push(blocker)
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null)
}

function salesByPresenter(sales) {
  const grouped = new Map()
  for (const sale of sales) {
    const id = sale.apresentadora_id
    if (!id) return null
    const current = grouped.get(id) ?? {
      apresentadora_id: id,
      nome: sale.apresentadora_nome ?? null,
      user_id: sale.apresentadora_user_id ?? null,
      gmvCents: 0n,
      pedidos: 0,
    }
    const cents = decimalToCents(sale.gmv)
    if (cents === null) return null
    current.gmvCents += cents
    current.pedidos += Number(sale.pedidos ?? 0)
    grouped.set(id, current)
  }
  return grouped
}

function validateAndResolveSplit(live, durationSeconds, blockers) {
  const sales = Array.isArray(live.vendas) ? live.vendas : []
  if (sales.length === 0) {
    addBlocker(blockers, 'ATTRIBUTED_SALES_MISSING', 'A live não possui vendas atribuídas para preservar.', live.id)
    return []
  }

  const invalidSale = sales.find((sale) =>
    sale.marca_id !== live.marca_id
    || sale.data !== live.inicio_dia_sp
    || sale.status_aprovacao !== 'pendente_aprovacao'
  )
  if (invalidSale) {
    const code = invalidSale.status_aprovacao !== 'pendente_aprovacao'
      ? 'COMMISSION_NOT_PENDING'
      : 'ATTRIBUTED_SALES_INCONSISTENT'
    addBlocker(blockers, code, 'As vendas atribuídas não estão em estado compatível com a união.', live.id)
  }

  const groupedSales = salesByPresenter(sales)
  if (!groupedSales) {
    addBlocker(blockers, 'ATTRIBUTED_SALES_INCONSISTENT', 'Toda venda precisa estar ligada a uma apresentadora válida.', live.id)
    return []
  }
  const saleGmv = [...groupedSales.values()].reduce((sum, item) => sum + item.gmvCents, 0n)
  const saleOrders = [...groupedSales.values()].reduce((sum, item) => sum + item.pedidos, 0)
  const invalidFinancial = sales.some((sale) => {
    const values = [sale.gmv, sale.comissao_apresentadora, sale.comissao_franquia, sale.comissao_franqueadora]
    const pedidos = Number(sale.pedidos)
    return values.some((value) => value == null || decimalToCents(value) === null || decimalToCents(value) < 0n)
      || !Number.isSafeInteger(pedidos) || pedidos < 0
  })
  if (invalidFinancial) {
    addBlocker(blockers, 'INVALID_FINANCIAL_VALUE', 'A live possui valor financeiro negativo, inválido ou fora da precisão aceita.', live.id)
  }
  if (saleGmv !== officialGmvCents(live) || saleOrders !== officialOrders(live)) {
    addBlocker(blockers, 'ATTRIBUTED_SALES_MISMATCH', 'GMV ou pedidos atribuídos divergem dos totais oficiais da live.', live.id)
  }

  const split = Array.isArray(live.apresentadoras) ? live.apresentadoras : []
  if (split.length <= 1) {
    const onlySale = groupedSales.size === 1 ? [...groupedSales.values()][0] : null
    const onlySplit = split[0]
    if (!onlySale || (onlySplit && onlySplit.apresentadora_id !== onlySale.apresentadora_id)) {
      addBlocker(blockers, 'AMBIGUOUS_PRESENTER', 'A apresentadora única da live não pôde ser determinada sem ambiguidade.', live.id)
      return []
    }
    return [{
      apresentadora_id: onlySale.apresentadora_id,
      nome: onlySplit?.nome ?? onlySale.nome,
      user_id: onlySplit?.user_id ?? onlySale.user_id,
      gmvCents: onlySale.gmvCents,
      segundos: durationSeconds,
      pedidos: onlySale.pedidos,
    }]
  }

  const complete = split.every((item) =>
    item.gmv_rateado !== null && item.gmv_rateado !== undefined
    && item.segundos_rateio !== null && item.segundos_rateio !== undefined
    && decimalToCents(item.gmv_rateado) !== null
    && decimalToCents(item.gmv_rateado) >= 0n
    && Number.isSafeInteger(Number(item.segundos_rateio))
    && Number(item.segundos_rateio) >= 0
  )
  const splitIds = new Set(split.map((item) => item.apresentadora_id))
  const samePresenters = splitIds.size === groupedSales.size
    && [...splitIds].every((id) => groupedSales.has(id))
  const splitGmv = complete ? sumMoney(split.map((item) => item.gmv_rateado)) : null
  const splitSeconds = complete
    ? split.reduce((sum, item) => sum + Number(item.segundos_rateio), 0)
    : null
  const perPresenterMatches = complete && samePresenters && split.every((item) =>
    decimalToCents(item.gmv_rateado) === groupedSales.get(item.apresentadora_id)?.gmvCents
  )
  if (!complete || !samePresenters || splitGmv !== officialGmvCents(live)
      || splitSeconds !== durationSeconds || !perPresenterMatches) {
    addBlocker(blockers, 'INCOMPLETE_PRESENTER_SPLIT', 'O rateio precisa fechar GMV e duração para todas as apresentadoras.', live.id)
  }

  return split.map((item) => {
    const sale = groupedSales.get(item.apresentadora_id)
    return {
      apresentadora_id: item.apresentadora_id,
      nome: item.nome ?? sale?.nome ?? null,
      user_id: item.user_id ?? sale?.user_id ?? null,
      gmvCents: sale?.gmvCents ?? decimalToCents(item.gmv_rateado) ?? 0n,
      segundos: Number(item.segundos_rateio ?? 0),
      pedidos: sale?.pedidos ?? 0,
    }
  })
}

export function stableLiveMergeHash(sources) {
  const ordered = [...sources].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const payload = JSON.stringify(canonical(ordered))
  return createHash('sha256').update(payload).digest('hex')
}

export function isLiveMergeEnabled(tenantId, env = process.env) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(String(tenantId ?? '')) || !env.LIVE_MERGE_TENANT_ALLOWLIST) return false
  if (env.LIVE_MERGE_TENANT_ALLOWLIST.trim() === '*') return true
  return env.LIVE_MERGE_TENANT_ALLOWLIST
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => uuid.test(item))
    .includes(String(tenantId).toLowerCase())
}

export function aggregateDestinationMetrics(sources) {
  const field = (names) => sources.map((row) => ({ value: firstDefined(row, names) }))
  const nullableMetric = (names) => nullableSum(field(names), 'value')
  const nullableMoney = (names) => nullableMoneySum(field(names), 'value')
  const peaks = sources.map((row) => row.final_peak_viewers)
  return {
    manual_views: nullableMetric(['manual_views']),
    manual_likes: nullableMetric(['manual_likes', 'final_total_likes']),
    manual_comments: nullableMetric(['manual_comments', 'final_total_comments']),
    manual_shares: nullableMetric(['manual_shares', 'final_total_shares']),
    manual_diamonds: nullableMetric(['manual_diamonds', 'final_gifts_diamonds']),
    ads_cost: nullableMoney(['ads_cost']),
    live_impressions: nullableMetric(['live_impressions']),
    product_impressions: nullableMetric(['product_impressions']),
    product_clicks: nullableMetric(['product_clicks']),
    new_followers: nullableMetric(['new_followers']),
    final_peak_viewers: peaks.some((value) => value === null || value === undefined)
      ? null
      : Math.max(...peaks.map(Number)),
  }
}

export function buildLiveMergePreview(sources, { requestedLiveIds } = {}) {
  const blockers = []
  const warnings = ['Confirme que cada registro contém somente as métricas do seu próprio trecho.']
  const requested = [...new Set((requestedLiveIds ?? sources.map((item) => item.id)).map(String))]
  if (requested.length < 2) addBlocker(blockers, 'MIN_LIVES', 'Selecione pelo menos duas lives.')
  if (requested.length > 20) addBlocker(blockers, 'MAX_LIVES', 'Selecione no máximo 20 lives.')
  if (requested.length !== (requestedLiveIds ?? []).length && requestedLiveIds) {
    addBlocker(blockers, 'DUPLICATE_LIVE_ID', 'A seleção contém lives repetidas.')
  }
  const foundIds = new Set(sources.map((item) => String(item.id)))
  for (const id of requested) {
    if (!foundIds.has(id)) addBlocker(blockers, 'LIVE_NOT_FOUND', 'Live não encontrada ou fora do tenant.', id)
  }

  const ordered = [...sources].sort((left, right) => {
    const a = epochMicros(left.iniciado_epoch)
    const b = epochMicros(right.iniciado_epoch)
    if (a === null || b === null || a === b) return String(left.id).localeCompare(String(right.id))
    return a < b ? -1 : 1
  })
  const base = ordered[0]
  const presenters = new Map()
  const origins = []
  let durationTotal = 0

  for (const live of ordered) {
    const start = epochMicros(live.iniciado_epoch)
    const end = epochMicros(live.encerrado_epoch)
    if (live.status !== 'encerrada' || !start || !end || end <= start) {
      addBlocker(blockers, 'LIVE_NOT_CLOSED', 'A live precisa estar encerrada e ter duração positiva.', live.id)
      continue
    }
    const durationMicros = end - start
    if (durationMicros % 1_000_000n !== 0n) {
      addBlocker(blockers, 'SUBSECOND_DURATION_UNSUPPORTED', 'A duração precisa fechar em segundos inteiros para preservar o rateio.', live.id)
    }
    const duration = Number(durationMicros / 1_000_000n)
    durationTotal += duration

    if (!live.marca_id) addBlocker(blockers, 'BRAND_REQUIRED', 'A live precisa ter marca.', live.id)
    if (live.faturado_em || live.boleto_id || live.has_boleto_live_link) {
      addBlocker(blockers, 'FINANCIAL_LINK_EXISTS', 'A live já possui vínculo de faturamento.', live.id)
    }
    if ((live.status_operacional && live.status_operacional !== 'ok')
        || String(live.problema ?? '').trim()
        || String(live.proxima_acao ?? '').trim()) {
      addBlocker(blockers, 'OPERATIONAL_REVIEW_REQUIRED', 'Resolva os alertas e anotações operacionais antes de unir esta live.', live.id)
    }
    if (live.uniao_destino_id || live.uniao_id) {
      addBlocker(blockers, 'ALREADY_MERGED', 'A live já participa de uma união.', live.id)
    }
    if (live.inicio_dia_sp !== live.fim_dia_sp) {
      addBlocker(blockers, 'CROSSES_OPERATIONAL_DAY', 'A live atravessa o dia operacional de São Paulo.', live.id)
    }
    if ((live.studio_metrics || live.ads_import_batch_id)
        && live.studio_metrics?.metric_scope !== 'segment') {
      addBlocker(blockers, 'IMPORTED_METRICS_SCOPE_AMBIGUOUS', 'A origem importada não comprova que as métricas pertencem somente a este trecho.', live.id)
    }
    const integerFields = [
      'manual_views', 'manual_likes', 'manual_comments', 'manual_shares',
      'manual_diamonds', 'manual_orders', 'final_orders_count', 'live_impressions',
      'product_impressions', 'product_clicks', 'new_followers', 'final_peak_viewers',
    ]
    if (integerFields.some((field) => live[field] != null
      && (!Number.isSafeInteger(Number(live[field])) || Number(live[field]) < 0))) {
      addBlocker(blockers, 'INVALID_METRIC', 'A live possui contador negativo ou fora do intervalo seguro.', live.id)
    }
    const gmv = officialGmvCents(live)
    const orders = officialOrders(live)
    if (gmv === null || gmv < 0n || !Number.isSafeInteger(orders) || orders < 0) {
      addBlocker(blockers, 'INVALID_METRIC', 'GMV ou pedidos oficiais são inválidos.', live.id)
    }
    const adsCost = live.ads_cost == null ? 0n : decimalToCents(live.ads_cost)
    if (adsCost === null || adsCost < 0n || adsCost > MAX_NUMERIC_15_CENTS) {
      addBlocker(blockers, 'INVALID_METRIC', 'O custo de anúncios é negativo ou excede o limite suportado.', live.id)
    }
    if (base) {
      const dimensions = [
        ['cabine_id', 'DIFFERENT_CABIN', 'As lives precisam usar a mesma cabine.'],
        ['marca_id', 'DIFFERENT_BRAND', 'As lives precisam pertencer à mesma marca.'],
        ['cliente_id', 'DIFFERENT_CLIENT', 'As lives precisam pertencer ao mesmo cliente.'],
        ['gestor_id', 'DIFFERENT_MANAGER', 'As lives precisam ter o mesmo gestor responsável.'],
        ['tipo', 'DIFFERENT_TYPE', 'As lives precisam ter o mesmo tipo.'],
        ['status_publicacao', 'DIFFERENT_PUBLICATION_STATUS', 'As lives precisam ter o mesmo status de publicação.'],
        ['tiktok_username', 'DIFFERENT_ACCOUNT', 'As lives precisam usar a mesma conta de transmissão.'],
        ['inicio_dia_sp', 'DIFFERENT_OPERATIONAL_DAY', 'As lives precisam estar no mesmo dia operacional de São Paulo.'],
      ]
      for (const [fieldName, code, message] of dimensions) {
        if (!sameValue(live[fieldName], base[fieldName])) addBlocker(blockers, code, message, live.id)
      }
      if (live.tiktok_room_id && base.tiktok_room_id
          && live.tiktok_room_id !== base.tiktok_room_id) {
        addBlocker(blockers, 'DIFFERENT_ROOM', 'As lives informam transmissões TikTok diferentes.', live.id)
      }
    }

    const resolved = validateAndResolveSplit(live, duration, blockers)
    for (const item of resolved) {
      const current = presenters.get(item.apresentadora_id) ?? {
        apresentadora_id: item.apresentadora_id,
        nome: item.nome,
        user_id: item.user_id,
        gmvCents: 0n,
        segundos: 0,
        pedidos: 0,
      }
      current.gmvCents += item.gmvCents
      current.segundos += item.segundos
      current.pedidos += item.pedidos
      presenters.set(item.apresentadora_id, current)
    }
    origins.push({
      live_id: live.id,
      iniciado_em: live.iniciado_em,
      encerrado_em: live.encerrado_em,
      marca_id: live.marca_id,
      marca_nome: live.marca_nome ?? null,
      cabine_id: live.cabine_id,
      cabine_numero: live.cabine_numero ?? null,
      apresentadoras: resolved.map((item) => ({
        apresentadora_id: item.apresentadora_id,
        nome: item.nome,
        gmv: centsToNumber(item.gmvCents),
        segundos: item.segundos,
        pedidos: item.pedidos,
      })),
    })
  }

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const currentEnd = epochMicros(ordered[index].encerrado_epoch)
    const nextStart = epochMicros(ordered[index + 1].iniciado_epoch)
    if (currentEnd === null || nextStart === null || currentEnd !== nextStart) {
      addBlocker(blockers, 'NOT_CONTIGUOUS', 'Cada live precisa terminar exatamente quando a próxima começa.', ordered[index + 1].id)
    }
  }
  if (durationTotal > DAY_SECONDS) addBlocker(blockers, 'DURATION_LIMIT', 'A transmissão consolidada não pode exceder 24 horas.')

  const allSales = ordered.flatMap((live) => live.vendas ?? [])
  const totalGmvCents = sumMoney(allSales.map((sale) => sale.gmv)) ?? 0n
  const totalOrders = allSales.reduce((sum, sale) => sum + Number(sale.pedidos ?? 0), 0)
  if (totalGmvCents > MAX_MANUAL_GMV_CENTS) {
    addBlocker(blockers, 'TOTAL_GMV_OUT_OF_RANGE', 'O GMV consolidado excede o limite suportado pela live.')
  }
  for (const [field, label] of [
    ['comissao_apresentadora', 'comissão da apresentadora'],
    ['comissao_franquia', 'comissão da franquia'],
    ['comissao_franqueadora', 'comissão da franqueadora'],
  ]) {
    const total = sumMoney(allSales.map((sale) => sale[field]))
    if (total === null || total < 0n || total > MAX_NUMERIC_15_CENTS) {
      addBlocker(blockers, 'TOTAL_FINANCIAL_OUT_OF_RANGE', `O total de ${label} é inválido ou excede o limite suportado.`)
    }
  }
  const totalAdsCost = ordered.some((live) => live.ads_cost == null)
    ? null
    : sumMoney(ordered.map((live) => live.ads_cost))
  if (totalAdsCost !== null && totalAdsCost > MAX_NUMERIC_15_CENTS) {
    addBlocker(blockers, 'TOTAL_FINANCIAL_OUT_OF_RANGE', 'O custo de anúncios consolidado excede o limite suportado.')
  }
  if (!Number.isSafeInteger(totalOrders) || totalOrders > MAX_INTEGER) {
    addBlocker(blockers, 'TOTAL_ORDERS_OUT_OF_RANGE', 'O total de pedidos excede o limite suportado pela live.')
  }
  const totals = aggregateDestinationMetrics(ordered)
  if (totals.live_impressions === null) {
    const known = ordered.filter((row) => row.live_impressions != null)
    const subtotal = known.reduce((sum, row) => sum + Number(row.live_impressions), 0)
    const missing = ordered.length - known.length
    warnings.push(`Impressões: subtotal conhecido ${subtotal}; faltam dados em ${missing} ${missing === 1 ? 'trecho' : 'trechos'}. Total permanece pendente.`)
  }
  if (totals.manual_views === null) {
    const known = ordered.filter((row) => row.manual_views != null)
    const subtotal = known.reduce((sum, row) => sum + Number(row.manual_views), 0)
    const missing = ordered.length - known.length
    warnings.push(`Visualizações: subtotal conhecido ${subtotal}; faltam dados em ${missing} ${missing === 1 ? 'trecho' : 'trechos'}. Total permanece pendente.`)
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    preview_token: `lm1:${stableLiveMergeHash(ordered)}`,
    origens: origins,
    totais: {
      gmv: centsToNumber(totalGmvCents),
      pedidos: totalOrders,
      segundos: durationTotal,
      live_impressions: totals.live_impressions,
      manual_views: totals.manual_views,
      comissao_apresentadora: centsToNumber(sumMoney(allSales.map((sale) => sale.comissao_apresentadora)) ?? 0n),
      comissao_franquia: centsToNumber(sumMoney(allSales.map((sale) => sale.comissao_franquia)) ?? 0n),
      comissao_franqueadora: centsToNumber(sumMoney(allSales.map((sale) => sale.comissao_franqueadora)) ?? 0n),
    },
    apresentadoras: [...presenters.values()].map((item) => ({
      apresentadora_id: item.apresentadora_id,
      nome: item.nome,
      user_id: item.user_id,
      gmv: centsToNumber(item.gmvCents),
      segundos: item.segundos,
      pedidos: item.pedidos,
    })),
    warnings,
  }
}

export function aggregateSalesByPresenter(sources) {
  const grouped = new Map()
  for (const sale of sources.flatMap((source) => source.vendas ?? [])) {
    // Uma união pode atravessar uma virada de contrato. Manter a condição no
    // agrupamento evita transformar dois snapshots temporais em uma linha sem
    // origem determinável.
    const key = `${sale.apresentadora_id ?? ''}:${sale.marca_condicao_id ?? ''}`
    const current = grouped.get(key) ?? {
      apresentadora_id: sale.apresentadora_id,
      marca_id: sale.marca_id,
      marca_condicao_id: sale.marca_condicao_id ?? null,
      data: sale.data,
      gmv: 0n,
      pedidos: 0,
      comissao_apresentadora: 0n,
      comissao_franquia: 0n,
      comissao_franqueadora: 0n,
    }
    current.gmv += decimalToCents(sale.gmv) ?? 0n
    current.pedidos += Number(sale.pedidos ?? 0)
    current.comissao_apresentadora += decimalToCents(sale.comissao_apresentadora) ?? 0n
    current.comissao_franquia += decimalToCents(sale.comissao_franquia) ?? 0n
    current.comissao_franqueadora += decimalToCents(sale.comissao_franqueadora) ?? 0n
    grouped.set(key, current)
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    gmv: centsToDecimal(item.gmv),
    comissao_apresentadora: centsToDecimal(item.comissao_apresentadora),
    comissao_franquia: centsToDecimal(item.comissao_franquia),
    comissao_franqueadora: centsToDecimal(item.comissao_franqueadora),
  }))
}
