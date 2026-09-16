import { createHash, randomUUID } from 'node:crypto'

import {
  aggregateDestinationMetrics,
  aggregateSalesByPresenter,
  buildLiveMergePreview,
  stableLiveMergeHash,
  sumMoneyDecimal,
} from '../lib/live-merge.js'
import { lockTenantLiveFinance } from '../lib/live-finance-lock.js'
import { normalizarRateio } from '../lib/live-rateio.js'
import { tiktokUsernameSql } from '../lib/tiktok-username.js'

export class LiveMergeError extends Error {
  constructor(message, { code, statusCode = 400, blockers } = {}) {
    super(message)
    this.name = 'LiveMergeError'
    this.code = code
    this.statusCode = statusCode
    this.blockers = blockers
  }
}

function normalizedIds(liveIds) {
  return [...new Set((liveIds ?? []).map(String))].sort()
}

function requestHash({ liveIds, previewToken, motivo, metricasPorTrecho }) {
  return createHash('sha256').update(JSON.stringify({
    live_ids: normalizedIds(liveIds),
    preview_token: previewToken,
    motivo: motivo ?? null,
    metricas_por_trecho: metricasPorTrecho === true,
  })).digest('hex')
}

function jsonParam(value) {
  return JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item)
}

async function safeRollback(db) {
  await db.query('ROLLBACK').catch(() => {})
}

export async function loadLiveMergeSources(db, { tenantId, liveIds, lock = false }) {
  const ids = normalizedIds(liveIds)
  const liveResult = await db.query(
    `/* live-merge:load-lives */
     SELECT l.id, l.tenant_id, l.cabine_id, c.numero AS cabine_numero,
            l.cliente_id, l.marca_id, m.nome AS marca_nome,
            ${tiktokUsernameSql({ marca: 'm', cliente: 'cl', contrato: 'ct' })} AS tiktok_username,
            l.apresentador_id, l.gestor_id, l.status, l.tipo, l.status_publicacao,
            l.origem_dados, l.iniciado_em::text AS iniciado_em,
            l.encerrado_em::text AS encerrado_em,
            EXTRACT(EPOCH FROM l.iniciado_em)::text AS iniciado_epoch,
            EXTRACT(EPOCH FROM l.encerrado_em)::text AS encerrado_epoch,
            to_char(l.iniciado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS inicio_dia_sp,
            to_char(l.encerrado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS fim_dia_sp,
            l.fat_gerado, l.comissao_calculada, l.final_orders_count,
            l.final_peak_viewers, l.final_total_likes, l.final_total_comments,
            l.final_total_shares, l.final_gifts_diamonds, l.resumo,
            l.manual_views, l.manual_likes, l.manual_comments, l.manual_shares,
            l.manual_diamonds, l.manual_orders, l.manual_gmv,
            l.ads_gmv, l.ads_cost, l.live_impressions, l.product_impressions,
            l.product_clicks, l.avg_viewing_duration, l.new_followers,
            l.status_operacional, l.problema, l.proxima_acao,
            l.comissao_apresentadora_pct, l.comissao_apresentadora_valor,
            l.comissao_recalculo_pendente, l.faturado_em, l.boleto_id,
            l.agenda_evento_id, l.tiktok_room_id, l.studio_metrics,
            l.ads_import_batch_id, l.ads_import_row_id,
            l.uniao_destino_id, l.uniao_id, l.uniao_desfeita_em,
            EXISTS (
              SELECT 1 FROM boletos b
               WHERE b.tenant_id = l.tenant_id AND b.live_id = l.id
            ) AS has_boleto_live_link
       FROM lives l
       LEFT JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
       LEFT JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
       LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = l.tenant_id
       LEFT JOIN clientes cl
         ON cl.id = COALESCE(m.cliente_id, l.cliente_id, ct.cliente_id)
        AND cl.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1::uuid AND l.id = ANY($2::uuid[])
      ORDER BY l.id
      ${lock ? 'FOR UPDATE OF l' : ''}`,
    [tenantId, ids],
  )
  const rateioResult = await db.query(
    `/* live-merge:load-rateio */
     SELECT lav.live_id, lav.apresentadora_id, a.nome, a.user_id, lav.papel,
            lav.percentual_rateio, lav.gmv_rateado, lav.segundos_rateio,
            lav.pedidos_rateados
       FROM live_apresentadoras_v2 lav
       JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
      WHERE lav.tenant_id = $1::uuid AND lav.live_id = ANY($2::uuid[])
      ORDER BY lav.live_id, lav.apresentadora_id
      ${lock ? 'FOR UPDATE OF lav' : ''}`,
    [tenantId, ids],
  )
  const salesResult = await db.query(
    `/* live-merge:load-sales */
     SELECT va.id, va.tenant_id, va.origem, va.origem_id, va.marca_id,
            va.apresentadora_id, a.nome AS apresentadora_nome,
            a.user_id AS apresentadora_user_id, va.data::text AS data, va.gmv, va.pedidos,
            va.comissao_apresentadora, va.comissao_franquia,
            va.comissao_franqueadora, va.marca_condicao_id, va.status_aprovacao, va.status_motivo,
            va.aprovado_por, va.aprovado_em, va.criado_em, va.atualizado_em
       FROM vendas_atribuidas va
       LEFT JOIN apresentadoras a
         ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
      WHERE va.tenant_id = $1::uuid
        AND va.origem = 'live'
        AND va.origem_id = ANY($2::uuid[])
      ORDER BY va.origem_id, va.apresentadora_id NULLS FIRST, va.id
      ${lock ? 'FOR UPDATE OF va' : ''}`,
    [tenantId, ids],
  )

  const rateios = new Map(ids.map((id) => [id, []]))
  for (const row of rateioResult.rows) rateios.get(String(row.live_id))?.push(row)
  const sales = new Map(ids.map((id) => [id, []]))
  for (const row of salesResult.rows) sales.get(String(row.origem_id))?.push(row)
  return liveResult.rows.map((live) => ({
    ...live,
    apresentadoras: rateios.get(String(live.id)) ?? [],
    vendas: sales.get(String(live.id)) ?? [],
  }))
}

async function readPreview(db, { tenantId, liveIds, lock = false }) {
  const sources = await loadLiveMergeSources(db, { tenantId, liveIds, lock })
  const preview = buildLiveMergePreview(sources, { requestedLiveIds: liveIds })
  return { sources, preview }
}

export async function previewLiveMerge(db, { tenantId, liveIds }) {
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const { preview } = await readPreview(db, { tenantId, liveIds })
    await db.query('COMMIT')
    return preview
  } catch (error) {
    await safeRollback(db)
    throw error
  }
}

function sourceSnapshots(sources) {
  return sources.map(({ apresentadoras, vendas, ...live }) => ({
    live,
    apresentadoras,
    vendas,
  }))
}

function choosePrincipal(presenters) {
  return [...presenters].sort((left, right) =>
    right.gmv - left.gmv
    || right.segundos - left.segundos
    || String(left.apresentadora_id).localeCompare(String(right.apresentadora_id)),
  )[0]
}

function financialFingerprint({ live, sales }) {
  return createHash('sha256').update(jsonParam({
    live: {
      id: live.id,
      fat_gerado: sumMoneyDecimal([live.fat_gerado]),
      manual_gmv: sumMoneyDecimal([live.manual_gmv]),
      manual_orders: live.manual_orders,
      final_orders_count: live.final_orders_count,
      comissao_calculada: sumMoneyDecimal([live.comissao_calculada]),
      comissao_apresentadora_valor: sumMoneyDecimal([live.comissao_apresentadora_valor]),
      faturado_em: live.faturado_em,
      boleto_id: live.boleto_id,
      has_boleto_live_link: Boolean(live.has_boleto_live_link),
      uniao_id: live.uniao_id,
      uniao_desfeita_em: live.uniao_desfeita_em,
    },
    sales: [...sales].map((sale) => ({
      marca_id: sale.marca_id,
      apresentadora_id: sale.apresentadora_id,
      data: sale.data,
      gmv: sumMoneyDecimal([sale.gmv]),
      pedidos: Number(sale.pedidos ?? 0),
      comissao_apresentadora: sumMoneyDecimal([sale.comissao_apresentadora]),
      comissao_franquia: sumMoneyDecimal([sale.comissao_franquia]),
      comissao_franqueadora: sumMoneyDecimal([sale.comissao_franqueadora]),
      marca_condicao_id: sale.marca_condicao_id ?? null,
      status_aprovacao: sale.status_aprovacao ?? 'pendente_aprovacao',
      status_motivo: sale.status_motivo ?? null,
      aprovado_por: sale.aprovado_por ?? null,
      aprovado_em: sale.aprovado_em ?? null,
    })).sort((a, b) => String(a.apresentadora_id).localeCompare(String(b.apresentadora_id))),
  })).digest('hex')
}

export async function mergeLives(db, {
  tenantId,
  userId,
  liveIds,
  previewToken,
  requestId,
  motivo,
  metricasPorTrecho,
  uuidFactory = randomUUID,
}) {
  if (metricasPorTrecho !== true) {
    throw new LiveMergeError('Confirme que as métricas pertencem a cada trecho.', {
      code: 'METRICS_SCOPE_CONFIRMATION_REQUIRED', statusCode: 400,
    })
  }
  const reqHash = requestHash({ liveIds, previewToken, motivo, metricasPorTrecho })
  await db.query('BEGIN')
  try {
    await lockTenantLiveFinance(db, tenantId)
    await db.query("SELECT set_config('livelab.live_merge_write', 'on', true)")
    await db.query(
      `/* live-merge:idempotency-lock */ SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${tenantId}:${requestId}`],
    )
    const existing = await db.query(
      `/* live-merge:existing-request */
       SELECT id, live_destino_id, request_hash
         FROM live_unioes
        WHERE tenant_id = $1::uuid AND request_id = $2::uuid
        FOR UPDATE`,
      [tenantId, requestId],
    )
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== reqHash) {
        throw new LiveMergeError('request_id já foi usado com outro conteúdo.', {
          code: 'IDEMPOTENCY_CONFLICT', statusCode: 409,
        })
      }
      await db.query('COMMIT')
      return { live_id: existing.rows[0].live_destino_id, uniao_id: existing.rows[0].id }
    }

    const { sources, preview } = await readPreview(db, { tenantId, liveIds, lock: true })
    if (!preview.eligible) {
      throw new LiveMergeError('As lives não atendem aos critérios de união.', {
        code: 'MERGE_NOT_ELIGIBLE', statusCode: 422, blockers: preview.blockers,
      })
    }
    if (preview.preview_token !== previewToken) {
      throw new LiveMergeError('Os dados das lives mudaram depois da prévia.', {
        code: 'PREVIEW_STALE', statusCode: 409,
      })
    }

    const unionId = uuidFactory()
    const destinationId = uuidFactory()
    const byId = new Map(sources.map((source) => [String(source.id), source]))
    const ordered = preview.origens.map((origin) => byId.get(String(origin.live_id)))
    const first = ordered[0]
    const last = ordered.at(-1)
    const destinationSource = ordered.some((source) => source.origem_dados === 'apresentadora')
      ? 'apresentadora'
      : 'manual'
    const destinationOperationalStatus = ordered.every((source) => source.status_operacional === 'ok')
      ? 'ok'
      : null
    const metrics = aggregateDestinationMetrics(ordered)
    const aggregatedSales = aggregateSalesByPresenter(ordered)
    const principal = choosePrincipal(preview.apresentadoras)
    const normalizedRateio = normalizarRateio(
      preview.apresentadoras.map((presenter) => ({
        apresentadora_id: presenter.apresentadora_id,
        gmv: presenter.gmv,
        segundos: presenter.segundos,
      })),
      { gmvLive: preview.totais.gmv, segundosLive: preview.totais.segundos },
    )
    const rateioByPresenter = new Map(normalizedRateio.map((item) => [item.apresentadora_id, item]))
    const commissionFranchise = sumMoneyDecimal(aggregatedSales.map((sale) => sale.comissao_franquia))
    const commissionPresenter = sumMoneyDecimal(aggregatedSales.map((sale) => sale.comissao_apresentadora))

    await db.query(
      `/* live-merge:insert-destination */
       INSERT INTO lives (
         id, tenant_id, cabine_id, cliente_id, apresentador_id, gestor_id,
         status, iniciado_em, encerrado_em, fat_gerado, comissao_calculada,
         final_orders_count, final_peak_viewers, final_total_likes,
         final_total_comments, final_total_shares, final_gifts_diamonds, resumo,
         manual_views, manual_likes, manual_comments, manual_shares, manual_diamonds,
         manual_orders, manual_gmv, tipo, status_publicacao, origem_dados,
         agenda_evento_id, marca_id, comissao_apresentadora_pct,
         comissao_apresentadora_valor, ads_gmv, ads_cost, live_impressions,
         product_impressions, product_clicks, avg_viewing_duration, new_followers,
         status_operacional, problema, proxima_acao,
         comissao_recalculo_pendente, uniao_id
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,
         'encerrada',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
         NULL,$28::uuid,NULL,$29,NULL,$30,$31,$32,$33,NULL,$34,
         $35,NULL,NULL,FALSE,$36::uuid
       ) RETURNING id`,
      [
        destinationId, tenantId, first.cabine_id, first.cliente_id,
        principal?.user_id ?? null, first.gestor_id ?? null, first.iniciado_em, last.encerrado_em,
        sumMoneyDecimal(aggregatedSales.map((sale) => sale.gmv)), commissionFranchise,
        preview.totais.pedidos, metrics.final_peak_viewers, metrics.manual_likes,
        metrics.manual_comments, metrics.manual_shares, metrics.manual_diamonds,
        `Transmissão consolidada de ${ordered.length} trechos.`,
        metrics.manual_views, metrics.manual_likes, metrics.manual_comments,
        metrics.manual_shares, metrics.manual_diamonds, preview.totais.pedidos,
        sumMoneyDecimal(aggregatedSales.map((sale) => sale.gmv)), first.tipo,
        first.status_publicacao, destinationSource, first.marca_id, commissionPresenter,
        metrics.ads_cost, metrics.live_impressions, metrics.product_impressions,
        metrics.product_clicks, metrics.new_followers, destinationOperationalStatus, unionId,
      ],
    )

    for (const presenter of preview.apresentadoras) {
      const rateio = rateioByPresenter.get(presenter.apresentadora_id)
      await db.query(
        `/* live-merge:insert-destination-rateio */
         INSERT INTO live_apresentadoras_v2 (
           tenant_id, live_id, apresentadora_id, papel, percentual_rateio,
           gmv_rateado, segundos_rateio, pedidos_rateados
         ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)`,
        [tenantId, destinationId, presenter.apresentadora_id,
          presenter.apresentadora_id === principal?.apresentadora_id ? 'principal' : 'apoio',
          rateio.percentual, presenter.gmv, presenter.segundos, presenter.pedidos],
      )
    }

    await db.query(
      `/* live-merge:delete-source-sales */
       DELETE FROM vendas_atribuidas
        WHERE tenant_id = $1::uuid AND origem = 'live' AND origem_id = ANY($2::uuid[])`,
      [tenantId, normalizedIds(liveIds)],
    )
    for (const sale of aggregatedSales) {
      await db.query(
        `/* live-merge:insert-destination-sale */
         INSERT INTO vendas_atribuidas (
           tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
           gmv, pedidos, comissao_apresentadora, comissao_franquia,
           comissao_franqueadora, marca_condicao_id, status_aprovacao
         ) VALUES ($1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,'pendente_aprovacao')`,
        [tenantId, destinationId, sale.marca_id, sale.apresentadora_id, sale.data,
          sale.gmv, sale.pedidos, sale.comissao_apresentadora,
          sale.comissao_franquia, sale.comissao_franqueadora, sale.marca_condicao_id],
      )
    }
    const persistedDestination = await db.query(
      `/* live-merge:read-destination-financial */
       SELECT id, fat_gerado, manual_gmv, manual_orders, final_orders_count,
              comissao_calculada, comissao_apresentadora_valor, faturado_em,
              boleto_id, uniao_id, uniao_desfeita_em,
              EXISTS (
                SELECT 1 FROM boletos b
                 WHERE b.tenant_id = lives.tenant_id AND b.live_id = lives.id
              ) AS has_boleto_live_link
         FROM lives WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, destinationId],
    )
    const persistedSales = await db.query(
      `/* live-merge:read-destination-sales */
       SELECT marca_id, apresentadora_id, data::text AS data, gmv, pedidos,
              comissao_apresentadora, comissao_franquia, comissao_franqueadora,
              marca_condicao_id, status_aprovacao, status_motivo, aprovado_por, aprovado_em
         FROM vendas_atribuidas
        WHERE tenant_id = $1::uuid AND origem = 'live' AND origem_id = $2::uuid
        ORDER BY apresentadora_id NULLS FIRST, id`,
      [tenantId, destinationId],
    )
    if (!persistedDestination.rows[0] || persistedSales.rows.length !== aggregatedSales.length) {
      throw new Error('União gravada com estado financeiro incompleto')
    }
    await db.query(
      `/* live-merge:mark-sources */
       UPDATE lives SET uniao_destino_id = $1::uuid
        WHERE tenant_id = $2::uuid AND id = ANY($3::uuid[])`,
      [destinationId, tenantId, normalizedIds(liveIds)],
    )

    const unionResult = {
      preview,
      source_hash: stableLiveMergeHash(sources),
      destination: {
        id: destinationId,
        financial_fingerprint: null,
        vendas: aggregatedSales,
      },
    }
    unionResult.destination.financial_fingerprint = financialFingerprint({
      live: persistedDestination.rows[0],
      sales: persistedSales.rows,
    })
    await db.query(
      `/* live-merge:insert-union */
       INSERT INTO live_unioes (
         id, tenant_id, live_destino_id, request_id, request_hash, preview_token,
         origens, resultado, motivo, criado_por
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8::jsonb,$9,$10::uuid)`,
      [unionId, tenantId, destinationId, requestId, reqHash, previewToken,
        jsonParam(sourceSnapshots(sources)), jsonParam(unionResult),
        motivo ?? 'União operacional de trechos contínuos', userId ?? null],
    )
    await db.query('COMMIT')
    return { live_id: destinationId, uniao_id: unionId }
  } catch (error) {
    await safeRollback(db)
    throw error
  }
}

export async function getLiveMergeHistory(db, { tenantId, liveId }) {
  const result = await db.query(
    `/* live-merge:history */
     SELECT u.id, u.live_destino_id, u.criado_em, u.criado_por, u.motivo,
            u.desfeito_em, u.desfeito_por, u.desfeito_motivo, u.origens, u.resultado
       FROM live_unioes u
      WHERE u.tenant_id = $1::uuid
        AND (
          u.live_destino_id = $2::uuid
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(u.origens) origem
             WHERE origem->'live'->>'id' = $2::text
          )
        )
      ORDER BY u.criado_em DESC
      LIMIT 1`,
    [tenantId, liveId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    ...row,
    ativo: !row.desfeito_em,
  }
}

async function loadUnionForUndo(db, { tenantId, unionId }) {
  const unionResult = await db.query(
    `/* live-merge:load-union */ SELECT * FROM live_unioes
      WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
    [tenantId, unionId],
  )
  return unionResult.rows[0] ?? null
}

export async function undoLiveMerge(db, {
  tenantId,
  userId,
  unionId,
  requestId,
  motivo,
}) {
  await db.query('BEGIN')
  try {
    await lockTenantLiveFinance(db, tenantId)
    await db.query("SELECT set_config('livelab.live_merge_write', 'on', true)")
    await db.query(
      `/* live-merge:idempotency-lock */ SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${tenantId}:undo:${requestId}`],
    )
    const union = await loadUnionForUndo(db, { tenantId, unionId })
    if (!union) {
      throw new LiveMergeError('União não encontrada.', { code: 'UNION_NOT_FOUND', statusCode: 404 })
    }
    const snapshots = typeof union.origens === 'string' ? JSON.parse(union.origens) : union.origens
    const sourceIds = snapshots.map((snapshot) => snapshot.live.id)
    if (union.desfeito_em) {
      if (String(union.desfeito_request_id) === String(requestId)) {
        await db.query('COMMIT')
        return { live_ids: sourceIds }
      }
      throw new LiveMergeError('Esta união já foi desfeita.', { code: 'UNION_ALREADY_UNDONE', statusCode: 409 })
    }

    const destinationResult = await db.query(
      `/* live-merge:lock-destination */
       SELECT id, fat_gerado, manual_gmv, manual_orders, final_orders_count,
              comissao_calculada, comissao_apresentadora_valor, faturado_em,
              boleto_id, uniao_id, uniao_desfeita_em,
              EXISTS (
                SELECT 1 FROM boletos b
                 WHERE b.tenant_id = lives.tenant_id AND b.live_id = lives.id
              ) AS has_boleto_live_link
         FROM lives WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
      [tenantId, union.live_destino_id],
    )
    const sourceResult = await db.query(
      `/* live-merge:lock-sources */
       SELECT id, uniao_destino_id FROM lives
        WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])
        ORDER BY id FOR UPDATE`,
      [tenantId, sourceIds],
    )
    const destination = destinationResult.rows[0]
    const sourceStateValid = sourceResult.rows.length === sourceIds.length
      && sourceResult.rows.every((source) => String(source.uniao_destino_id) === String(union.live_destino_id))
    if (!destination || destination.uniao_id !== union.id || destination.uniao_desfeita_em || !sourceStateValid) {
      throw new LiveMergeError('O estado das lives mudou depois da união.', {
        code: 'UNION_STATE_CHANGED', statusCode: 409,
      })
    }
    if (destination.faturado_em || destination.boleto_id || destination.has_boleto_live_link) {
      throw new LiveMergeError('A live consolidada possui vínculo de faturamento e não pode ser desfeita automaticamente.', {
        code: 'UNION_FINANCE_CHANGED', statusCode: 409,
      })
    }
    const salesResult = await db.query(
      `/* live-merge:lock-destination-sales */
       SELECT va.id, va.tenant_id, va.origem, va.origem_id, va.marca_id,
              va.apresentadora_id, va.data::text AS data, va.gmv, va.pedidos,
              va.comissao_apresentadora, va.comissao_franquia,
              va.comissao_franqueadora, va.marca_condicao_id, va.status_aprovacao, va.status_motivo,
              va.aprovado_por, va.aprovado_em, va.criado_em, va.atualizado_em
         FROM vendas_atribuidas va
        WHERE va.tenant_id = $1::uuid AND va.origem = 'live' AND va.origem_id = $2::uuid
        ORDER BY va.apresentadora_id NULLS FIRST, va.id FOR UPDATE`,
      [tenantId, union.live_destino_id],
    )
    const resultSnapshot = typeof union.resultado === 'string' ? JSON.parse(union.resultado) : union.resultado
    const currentFingerprint = financialFingerprint({ live: destination, sales: salesResult.rows })
    if (currentFingerprint !== resultSnapshot?.destination?.financial_fingerprint) {
      throw new LiveMergeError('Os valores financeiros da live consolidada mudaram; a reversão exige revisão manual.', {
        code: 'UNION_FINANCE_CHANGED', statusCode: 409,
      })
    }

    await db.query(
      `/* live-merge:delete-destination-sales */ DELETE FROM vendas_atribuidas
        WHERE tenant_id = $1::uuid AND origem = 'live' AND origem_id = $2::uuid`,
      [tenantId, union.live_destino_id],
    )
    for (const snapshot of snapshots) {
      for (const sale of snapshot.vendas) {
        await db.query(
          `/* live-merge:restore-source-sale */
           INSERT INTO vendas_atribuidas (
             id, tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
             gmv, pedidos, comissao_apresentadora, comissao_franquia,
             comissao_franqueadora, marca_condicao_id, status_aprovacao, status_motivo,
             aprovado_por, aprovado_em, criado_em, atualizado_em
           ) VALUES (
             $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,
             $8,$9,$10,$11,$12,$13,$14,$15::uuid,$16,$17,$18,$19
           )`,
          [sale.id, tenantId, sale.origem, sale.origem_id, sale.marca_id,
            sale.apresentadora_id, sale.data, sale.gmv, sale.pedidos,
            sale.comissao_apresentadora, sale.comissao_franquia,
            sale.comissao_franqueadora, sale.marca_condicao_id, sale.status_aprovacao, sale.status_motivo,
            sale.aprovado_por, sale.aprovado_em, sale.criado_em, sale.atualizado_em],
        )
      }
    }
    await db.query(
      `/* live-merge:unmark-sources */ UPDATE lives SET uniao_destino_id = NULL
        WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
      [tenantId, sourceIds],
    )
    await db.query(
      `/* live-merge:mark-destination-undone */ UPDATE lives SET uniao_desfeita_em = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, union.live_destino_id],
    )
    await db.query(
      `/* live-merge:mark-union-undone */
       UPDATE live_unioes
          SET desfeito_por = $1::uuid, desfeito_em = NOW(), desfeito_motivo = $2,
              desfeito_request_id = $3::uuid
        WHERE tenant_id = $4::uuid AND id = $5::uuid`,
      [userId ?? null, motivo ?? null, requestId, tenantId, unionId],
    )
    await db.query('COMMIT')
    return { live_ids: sourceIds }
  } catch (error) {
    await safeRollback(db)
    throw error
  }
}
