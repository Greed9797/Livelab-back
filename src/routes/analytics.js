import { READ_ANALYTICS, WRITE_LIVES } from '../config/role_groups.js'
import {
  loadAnalyticsImportCandidates,
  matchAnalyticsImportRows,
  parseAnalyticsImportBuffer,
  summarizeImportRows,
} from '../services/analytics-import.js'
import { getPerformanceRanking } from '../lib/performance-rollups.js'
import { liveGmvSql } from '../lib/metric-sql.js'

const ANALYTICS_TZ = 'America/Sao_Paulo'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function round2(value) {
  return parseFloat(Number(value ?? 0).toFixed(2))
}

function round1(value) {
  return parseFloat(Number(value ?? 0).toFixed(1))
}

function toInt(value) {
  return Number(value ?? 0)
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ANALYTICS_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${byType.year}-${byType.month}`
}

function monthEnd(monthValue) {
  const [year, month] = monthValue.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function isValidDateString(value) {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isValidMonthString(value) {
  if (!MONTH_RE.test(value)) return false
  const month = Number(value.slice(5, 7))
  return month >= 1 && month <= 12
}

function resolveAnalyticsPeriod(query) {
  const { from, to, mesAno, mes, ano } = query

  if (from || to) {
    if (!from || !to || !isValidDateString(from) || !isValidDateString(to)) {
      return { error: 'from/to must be YYYY-MM-DD' }
    }
    if (from > to) return { error: 'from must be before or equal to to' }
    return { fromDate: from, toDate: to, mesAno: from.slice(0, 7) }
  }

  const monthValue = mesAno ?? (mes && ano ? `${ano}-${String(mes).padStart(2, '0')}` : currentMonth())
  if (!isValidMonthString(monthValue)) return { error: 'mesAno must be YYYY-MM' }

  return {
    fromDate: `${monthValue}-01`,
    toDate: monthEnd(monthValue),
    mesAno: monthValue,
  }
}

async function readAnalyticsImportUpload(request) {
  if (request.isMultipart?.()) {
    const file = await request.file()
    if (!file) throw new Error('Arquivo CSV/XLSX obrigatorio')
    return { filename: file.filename, buffer: await file.toBuffer() }
  }

  const body = request.body ?? {}
  if (body.content_base64) {
    return {
      filename: body.filename ?? 'analytics-import.xlsx',
      buffer: Buffer.from(String(body.content_base64), 'base64'),
    }
  }
  if (body.content) {
    return {
      filename: body.filename ?? 'analytics-import.csv',
      buffer: Buffer.from(String(body.content), 'utf8'),
    }
  }
  throw new Error('Envie multipart file ou content_base64')
}

function rowResponse(row) {
  return {
    row_index: row.row_index,
    marca_nome: row.normalized?.marca_nome ?? row.marca_nome,
    live_date: row.normalized?.live_date ?? row.live_date,
    start_time: row.normalized?.start_time ?? row.start_time,
    duration_seconds: row.normalized?.duration_seconds ?? row.duration_seconds,
    ads_gmv: row.normalized?.ads_gmv ?? null,
    ads_cost: row.normalized?.ads_cost ?? null,
    attributed_orders: row.normalized?.attributed_orders ?? null,
    views: row.normalized?.views ?? null,
    match_status: row.match_status,
    match_reason: row.match_reason,
    match_confidence: row.match_confidence ?? null,
    matched_live_id: row.matched_live_id ?? null,
    matched_agenda_evento_id: row.matched_agenda_evento_id ?? null,
    candidates: row.candidates ?? [],
    error: row.error ?? null,
  }
}

function rowsDateRange(rows) {
  const dates = rows.map((r) => r.normalized.live_date).filter(Boolean).sort()
  if (dates.length === 0) return null
  return { fromDate: dates[0], toDate: dates[dates.length - 1] }
}

export async function analyticsRoutes(app) {
  app.post('/v1/analytics/imports/preview', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { tenant_id, sub } = request.user
    try {
      const upload = await readAnalyticsImportUpload(request)
      const parsedRows = parseAnalyticsImportBuffer(upload)
      if (parsedRows.length === 0) {
        return reply.code(400).send({ error: 'Arquivo sem linhas importaveis' })
      }

      const range = rowsDateRange(parsedRows)
      if (!range) return reply.code(400).send({ error: 'Nenhuma linha com data valida encontrada' })

      return await app.withTenant(tenant_id, async (db) => {
        await db.query('BEGIN')
        try {
          const candidates = await loadAnalyticsImportCandidates(db, range)
          const matchedRows = matchAnalyticsImportRows(parsedRows, candidates)
          const summary = summarizeImportRows(matchedRows)

          const batchQ = await db.query(
            `INSERT INTO analytics_import_batches (
               tenant_id, filename, total_rows, matched_rows, ambiguous_rows,
               unmatched_rows, skipped_rows, invalid_rows, summary, created_by
             )
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
             RETURNING id`,
            [
              tenant_id,
              upload.filename,
              summary.total_rows,
              summary.matched_rows,
              summary.ambiguous_rows,
              summary.unmatched_rows,
              summary.skipped_rows,
              summary.invalid_rows,
              JSON.stringify(summary),
              sub ?? null,
            ],
          )
          const batchId = batchQ.rows[0].id

          for (const row of matchedRows) {
            await db.query(
              `INSERT INTO analytics_import_rows (
                 tenant_id, batch_id, row_index, raw, normalized,
                 marca_nome, live_date, start_time, duration_seconds,
                 matched_live_id, matched_agenda_evento_id,
                 match_status, match_confidence, match_reason, candidates
               )
               VALUES (
                 $1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb,
                 $6, $7::date, $8, $9,
                 $10::uuid, $11::uuid,
                 $12, $13, $14, $15::jsonb
               )`,
              [
                tenant_id,
                batchId,
                row.row_index,
                JSON.stringify(row.raw),
                JSON.stringify(row.normalized),
                row.normalized.marca_nome,
                row.normalized.live_date,
                row.normalized.start_time,
                row.normalized.duration_seconds,
                row.matched_live_id ?? null,
                row.matched_agenda_evento_id ?? null,
                row.match_status,
                row.match_confidence ?? null,
                row.match_reason ?? null,
                JSON.stringify(row.candidates ?? []),
              ],
            )
          }

          await db.query('COMMIT')
          return {
            batch_id: batchId,
            filename: upload.filename,
            summary,
            rows: matchedRows.map(rowResponse),
          }
        } catch (err) {
          await db.query('ROLLBACK').catch(() => {})
          throw err
        }
      })
    } catch (err) {
      request.log.error({ err }, 'analytics/imports/preview error')
      return reply.code(400).send({ error: err.message })
    }
  })

  app.post('/v1/analytics/imports/:id/apply', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { tenant_id, sub } = request.user
    const batchId = request.params.id
    if (!UUID_RE.test(batchId)) return reply.code(400).send({ error: 'id must be a valid UUID' })

    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const batchQ = await db.query(
          `SELECT id, status
             FROM analytics_import_batches
            WHERE id = $1::uuid
              AND tenant_id = $2::uuid
            FOR UPDATE`,
          [batchId, tenant_id],
        )
        const batch = batchQ.rows[0]
        if (!batch) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Importacao nao encontrada' })
        }
        if (batch.status === 'applied') {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Importacao ja aplicada' })
        }

        const rowsQ = await db.query(
          `SELECT id, matched_live_id, normalized
             FROM analytics_import_rows
            WHERE tenant_id = $1::uuid
              AND batch_id = $2::uuid
              AND match_status = 'matched'
              AND matched_live_id IS NOT NULL
            ORDER BY row_index ASC
            FOR UPDATE`,
          [tenant_id, batchId],
        )

        let applied = 0
        for (const row of rowsQ.rows) {
          const n = row.normalized ?? {}
          await db.query(
            `UPDATE lives
                SET ads_gmv = $1,
                    ads_cost = $2,
                    live_impressions = $3,
                    product_impressions = $4,
                    product_clicks = $5,
                    avg_viewing_duration = $6,
                    new_followers = $7,
                    manual_views = $8,
                    manual_comments = $9,
                    manual_likes = $10,
                    manual_shares = $11,
                    manual_orders = $12,
                    ads_import_batch_id = $13::uuid,
                    ads_import_row_id = $14::uuid,
                    ads_metrics_updated_at = NOW()
              WHERE id = $15::uuid
                AND tenant_id = $16::uuid`,
            [
              n.ads_gmv ?? null,
              n.ads_cost ?? null,
              n.live_impressions ?? null,
              n.product_impressions ?? null,
              n.product_clicks ?? null,
              n.avg_viewing_duration ?? null,
              n.new_followers ?? null,
              n.views ?? null,
              n.comments ?? null,
              n.likes ?? null,
              n.shares ?? null,
              n.attributed_orders ?? null,
              batchId,
              row.id,
              row.matched_live_id,
              tenant_id,
            ],
          )
          await db.query(
            `UPDATE analytics_import_rows
                SET applied_at = NOW(), error = NULL
              WHERE id = $1::uuid
                AND tenant_id = $2::uuid`,
            [row.id, tenant_id],
          )
          applied++
        }

        await db.query(
          `UPDATE analytics_import_batches
              SET status = 'applied',
                  applied_rows = $1,
                  applied_by = $2,
                  applied_at = NOW()
            WHERE id = $3::uuid
              AND tenant_id = $4::uuid`,
          [applied, sub ?? null, batchId, tenant_id],
        )

        await db.query('COMMIT')
        return { ok: true, batch_id: batchId, applied_rows: applied }
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        request.log.error({ err }, 'analytics/imports/apply error')
        return reply.code(500).send({ error: err.message })
      }
    })
  })

  app.get('/v1/analytics/franqueado/resumo', {
    preHandler: [
      app.authenticate,
      app.requirePapel(READ_ANALYTICS),
    ],
  }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const [
        resumoHojeQ,
        rankingClosersQ,
        rankingClientesQ,
        heatmapHorariosQ,
        eficienciaCabinesQ,
      ] = await Promise.all([
        // Defesa em profundidade: filtros tenant_id explícitos via current_setting.
        // Role Postgres do Supabase tem BYPASSRLS, então RLS sozinha não basta.
        db.query(`
        WITH lives_ao_vivo AS (
          SELECT c.live_atual_id AS live_id
          FROM cabines c
          WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND c.status = 'ao_vivo'
            AND c.live_atual_id IS NOT NULL
        ), snapshots_recentes AS (
          SELECT DISTINCT ON (ls.live_id)
                 ls.live_id,
                 ls.viewer_count,
                 ls.gmv
          FROM live_snapshots ls
          JOIN lives_ao_vivo laov ON laov.live_id = ls.live_id
          WHERE ls.tenant_id = current_setting('app.tenant_id', true)::uuid
          ORDER BY ls.live_id, ls.captured_at DESC
        )
        SELECT
          COALESCE(SUM(sr.gmv), 0) AS gmv_total_hoje,
          COALESCE(SUM(sr.viewer_count), 0) AS audiencia_total_ao_vivo,
          (
            SELECT COUNT(*)
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              AND date_trunc('day', l.iniciado_em) = date_trunc('day', NOW())
          ) AS total_lives_hoje
        FROM snapshots_recentes sr
      `),
        db.query(`
        SELECT
          u.id AS apresentador_id,
          u.nome AS apresentador_nome,
          COUNT(l.id) AS total_lives,
          COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_total
        FROM lives l
        JOIN users u ON u.id = l.apresentador_id
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
        GROUP BY u.id, u.nome
        ORDER BY gmv_total DESC, total_lives DESC, apresentador_nome ASC
        LIMIT 5
      `),
        db.query(`
        SELECT
          c.id AS cliente_id,
          c.nome AS cliente_nome,
          COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_total,
          MAX(l.iniciado_em) AS ultima_live
        FROM lives l
        JOIN clientes c ON c.id = l.cliente_id AND c.tenant_id = l.tenant_id
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
        GROUP BY c.id, c.nome
        ORDER BY gmv_total DESC, ultima_live DESC NULLS LAST, cliente_nome ASC
        LIMIT 5
      `),
        db.query(`
        SELECT
          EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
          COUNT(*) AS total_lives,
          COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_total
        FROM lives l
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
        GROUP BY 1
        ORDER BY 1 ASC
      `),
        db.query(`
        SELECT
          c.id AS cabine_id,
          CONCAT('Cabine ', LPAD(c.numero::text, 2, '0')) AS cabine_nome,
          COUNT(l.id) AS total_lives,
          COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_acumulado
        FROM cabines c
        LEFT JOIN lives l
          ON l.cabine_id = c.id
         AND l.tenant_id = c.tenant_id
         AND l.status = 'encerrada'
        WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
        GROUP BY c.id, c.numero
        ORDER BY gmv_acumulado DESC, total_lives DESC, c.numero ASC
        LIMIT 5
      `),
      ])

      const resumoHoje = resumoHojeQ.rows[0] ?? {}

      return {
        resumo_hoje: {
          gmv_total_hoje: parseFloat(Number(resumoHoje.gmv_total_hoje ?? 0).toFixed(2)),
          audiencia_total_ao_vivo: Number(resumoHoje.audiencia_total_ao_vivo ?? 0),
          total_lives_hoje: Number(resumoHoje.total_lives_hoje ?? 0),
        },
        ranking_closers: rankingClosersQ.rows.map((row) => ({
          apresentador_id: row.apresentador_id,
          apresentador_nome: row.apresentador_nome,
          total_lives: Number(row.total_lives),
          gmv_total: parseFloat(Number(row.gmv_total).toFixed(2)),
        })),
        ranking_clientes: rankingClientesQ.rows.map((row) => ({
          cliente_id: row.cliente_id,
          cliente_nome: row.cliente_nome,
          gmv_total: parseFloat(Number(row.gmv_total).toFixed(2)),
          ultima_live: row.ultima_live,
        })),
        heatmap_horarios: heatmapHorariosQ.rows.map((row) => ({
          hora: Number(row.hora),
          total_lives: Number(row.total_lives),
          gmv_total: parseFloat(Number(row.gmv_total).toFixed(2)),
        })),
        eficiencia_cabines: eficienciaCabinesQ.rows.map((row) => ({
          cabine_id: row.cabine_id,
          cabine_nome: row.cabine_nome,
          total_lives: Number(row.total_lives),
          gmv_acumulado: parseFloat(Number(row.gmv_acumulado).toFixed(2)),
        })),
      }
    })
  })

  app.get('/v1/analytics/dashboard', {
    preHandler: [
      app.authenticate,
      app.requirePapel(READ_ANALYTICS),
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          cliente_id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          mesAno: { type: 'string' },
          mes: { type: 'string' },
          ano: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { cliente_id } = request.query

    if (cliente_id && !UUID_RE.test(cliente_id)) {
      return reply.code(400).send({ error: 'cliente_id must be a valid UUID' })
    }

    const period = resolveAnalyticsPeriod(request.query)
    if (period.error) return reply.code(400).send({ error: period.error })

    const { fromDate, toDate, mesAno } = period
    const days = Math.floor((new Date(`${toDate}T00:00:00.000Z`) - new Date(`${fromDate}T00:00:00.000Z`)) / 86400000) + 1
    const prevTo = addDays(fromDate, -1)
    const prevFrom = addDays(prevTo, -days + 1)

    const params = cliente_id ? [fromDate, toDate, cliente_id] : [fromDate, toDate]
    const prevParams = cliente_id ? [prevFrom, prevTo, cliente_id] : [prevFrom, prevTo]

    try {
      return await app.withTenant(tenant_id, async (db) => {
        const rankingRange = { start: fromDate, end: addDays(toDate, 1), mes: mesAno }
        const clienteSalesJoin = cliente_id
          ? 'JOIN marcas m_cliente ON m_cliente.id = va.marca_id AND m_cliente.tenant_id = va.tenant_id AND m_cliente.cliente_id = $3::uuid'
          : ''
        const clienteMarcaFilter = cliente_id ? 'AND m.cliente_id = $3::uuid' : ''
        const clienteLiveFilter = cliente_id ? 'AND l.cliente_id = $3::uuid' : ''
        const clienteVideoJoin = cliente_id
          ? 'JOIN marcas m ON m.id = vr.marca_id AND m.tenant_id = vr.tenant_id AND m.cliente_id = $3::uuid'
          : ''

        const salesWhere = `
          va.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND va.origem IN ('live', 'video')
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
          AND va.data >= $1::date
          AND va.data <= $2::date
        `
        const liveRange = `
          AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= $1::date
          AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date <= $2::date
        `
        const videoRange = `
          AND vr.data >= $1::date
          AND vr.data <= $2::date
        `

        const [
          salesCurQ,
          salesPrevQ,
          liveOpsQ,
          videoOpsQ,
          monthlyQ,
          hoursQ,
          presenterRankingQ,
          brandRankingQ,
          peakHoursQ,
          heatmapQ,
        ] = await Promise.all([
          db.query(`
            WITH live_sales AS (
              SELECT
                COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_lives,
                COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos_lives
              FROM lives l
              WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND l.status = 'encerrada'
                ${liveRange}
                ${clienteLiveFilter}
            ),
            video_sales AS (
              SELECT
                COALESCE(SUM(va.gmv), 0) AS gmv_videos,
                COALESCE(SUM(va.pedidos), 0)::int AS pedidos_videos
              FROM vendas_atribuidas va
              ${clienteSalesJoin}
              WHERE ${salesWhere}
                AND va.origem = 'video'
            )
            SELECT
              (ls.gmv_lives + vs.gmv_videos) AS gmv_total,
              ls.gmv_lives,
              vs.gmv_videos,
              (ls.pedidos_lives + vs.pedidos_videos)::int AS pedidos_total,
              ls.pedidos_lives,
              vs.pedidos_videos
            FROM live_sales ls CROSS JOIN video_sales vs
          `, params),

          db.query(`
            WITH live_sales AS (
              SELECT
                COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_lives,
                COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos_lives
              FROM lives l
              WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND l.status = 'encerrada'
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= $1::date
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date <= $2::date
                ${clienteLiveFilter}
            ),
            video_sales AS (
              SELECT
                COALESCE(SUM(va.gmv), 0) AS gmv_videos,
                COALESCE(SUM(va.pedidos), 0)::int AS pedidos_videos
              FROM vendas_atribuidas va
              ${clienteSalesJoin}
              WHERE ${salesWhere}
                AND va.origem = 'video'
            )
            SELECT
              (ls.gmv_lives + vs.gmv_videos) AS gmv_total,
              (ls.pedidos_lives + vs.pedidos_videos)::int AS pedidos_total
            FROM live_sales ls CROSS JOIN video_sales vs
          `, prevParams),

          db.query(`
            SELECT
              COUNT(*)::int AS total_lives,
              COALESCE(SUM(
                CASE
                  WHEN COALESCE(l.encerrado_em, l.previsto_fim) IS NOT NULL
                   AND COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
                    THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
                  ELSE 0
                END
              ), 0) AS horas_live,
              COALESCE(SUM(COALESCE(l.final_peak_viewers, l.manual_views, 0)), 0)::bigint AS viewers_total,
              COALESCE(SUM(COALESCE(l.final_total_likes, l.manual_likes, 0)), 0)::bigint AS likes_total,
              COALESCE(SUM(COALESCE(l.final_total_comments, l.manual_comments, 0)), 0)::bigint AS comentarios_total,
              COALESCE(SUM(COALESCE(l.final_total_shares, l.manual_shares, 0)), 0)::bigint AS shares_total,
              COALESCE(SUM(COALESCE(l.final_gifts_diamonds, l.manual_diamonds, 0)), 0)::bigint AS diamonds_total
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              ${liveRange}
              ${clienteLiveFilter}
          `, params),

          db.query(`
            SELECT
              COUNT(*)::int AS registros_video,
              COALESCE(SUM(vr.quantidade), 0)::int AS total_videos
            FROM video_registros vr
            ${clienteVideoJoin}
            WHERE vr.tenant_id = current_setting('app.tenant_id', true)::uuid
              ${videoRange}
          `, params),

          db.query(`
            -- $1 (fromDate) é compartilhado com as outras queries do Promise.all
            -- mas esta CTE só usa $2 (toDate). Cast explícito abaixo força tipagem
            -- do parâmetro $1 — sem isso o Postgres lança "could not determine
            -- data type of parameter $1" porque $1 nunca aparece tipado na query.
            WITH typed_params AS (SELECT $1::date AS _from, $2::date AS _to),
            analytics_months AS (
              SELECT generate_series(
                date_trunc('month', $2::date) - interval '11 months',
                date_trunc('month', $2::date),
                interval '1 month'
              )::date AS mes_inicio
            ),
            live_sales AS (
              SELECT
                date_trunc('month', l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS mes_inicio,
                COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_lives,
                COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos_lives
              FROM lives l
              WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND l.status = 'encerrada'
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= (date_trunc('month', $2::date) - interval '11 months')::date
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date < (date_trunc('month', $2::date) + interval '1 month')::date
                ${clienteLiveFilter}
              GROUP BY 1
            ),
            video_sales AS (
              SELECT
                date_trunc('month', va.data)::date AS mes_inicio,
                COALESCE(SUM(va.gmv), 0) AS gmv_videos,
                COALESCE(SUM(va.pedidos), 0)::int AS pedidos_videos
              FROM vendas_atribuidas va
              ${clienteSalesJoin}
              WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND va.origem = 'video'
                AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
                AND va.data >= date_trunc('month', $2::date) - interval '11 months'
                AND va.data < date_trunc('month', $2::date) + interval '1 month'
              GROUP BY 1
            ),
            lives_ops AS (
              SELECT
                date_trunc('month', l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS mes_inicio,
                COUNT(*)::int AS total_lives
              FROM lives l
              WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND l.status = 'encerrada'
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= (date_trunc('month', $2::date) - interval '11 months')::date
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date < (date_trunc('month', $2::date) + interval '1 month')::date
                ${clienteLiveFilter}
              GROUP BY 1
            ),
            videos_ops AS (
              SELECT
                date_trunc('month', vr.data)::date AS mes_inicio,
                COALESCE(SUM(vr.quantidade), 0)::int AS total_videos
              FROM video_registros vr
              ${clienteVideoJoin}
              WHERE vr.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND vr.data >= (date_trunc('month', $2::date) - interval '11 months')::date
                AND vr.data < (date_trunc('month', $2::date) + interval '1 month')::date
              GROUP BY 1
            )
            SELECT
              to_char(m.mes_inicio, 'YYYY-MM') AS mes,
              COALESCE(ls.gmv_lives, 0) + COALESCE(vs.gmv_videos, 0) AS gmv,
              COALESCE(ls.gmv_lives, 0) AS gmv_lives,
              COALESCE(vs.gmv_videos, 0) AS gmv_videos,
              (COALESCE(ls.pedidos_lives, 0) + COALESCE(vs.pedidos_videos, 0))::int AS pedidos,
              COALESCE(l.total_lives, 0)::int AS total_lives,
              COALESCE(v.total_videos, 0)::int AS total_videos
            FROM analytics_months m
            LEFT JOIN live_sales ls ON ls.mes_inicio = m.mes_inicio
            LEFT JOIN video_sales vs ON vs.mes_inicio = m.mes_inicio
            LEFT JOIN lives_ops l ON l.mes_inicio = m.mes_inicio
            LEFT JOIN videos_ops v ON v.mes_inicio = m.mes_inicio
            ORDER BY m.mes_inicio ASC
          `, params),

          db.query(`
            SELECT
              (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS dia,
              COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_lives,
              COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos_lives,
              COALESCE(SUM(
                CASE
                  WHEN COALESCE(l.encerrado_em, l.previsto_fim) IS NOT NULL
                   AND COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
                    THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
                  ELSE 0
                END
              ), 0) AS horas
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              ${liveRange}
              ${clienteLiveFilter}
            GROUP BY 1
            ORDER BY 1 ASC
          `, params),

          getPerformanceRanking(db, {
            tenantId: tenant_id,
            range: rankingRange,
            groupBy: 'apresentadora',
            limit: 10,
            clienteId: cliente_id ?? null,
          }),

          getPerformanceRanking(db, {
            tenantId: tenant_id,
            range: rankingRange,
            groupBy: 'marca',
            limit: 10,
            clienteId: cliente_id ?? null,
          }),

          db.query(`
            SELECT
              EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::int AS hora,
              COUNT(*)::int AS total_lives,
              COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              ${liveRange}
              ${clienteLiveFilter}
            GROUP BY 1
            ORDER BY 1 ASC
          `, params),

          db.query(`
            SELECT
              EXTRACT(ISODOW FROM l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::int AS dow,
              (FLOOR(EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}') / 3) * 3)::int AS bloco_hora,
              COUNT(*)::int AS lives,
              COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              ${liveRange}
              ${clienteLiveFilter}
            GROUP BY 1, 2
            ORDER BY 1, 2
          `, params),
        ])

        const sales = salesCurQ.rows[0] ?? {}
        const prevSales = salesPrevQ.rows[0] ?? {}
        const liveOps = liveOpsQ.rows[0] ?? {}
        const videoOps = videoOpsQ.rows[0] ?? {}

        const gmvTotal = round2(sales.gmv_total)
        const pedidosTotal = toInt(sales.pedidos_total)
        const ticketMedio = pedidosTotal > 0 ? round2(gmvTotal / pedidosTotal) : 0
        const gmvPrev = Number(prevSales.gmv_total ?? 0)
        const pedidosPrev = Number(prevSales.pedidos_total ?? 0)
        const ticketPrev = pedidosPrev > 0 ? gmvPrev / pedidosPrev : 0
        const pct = (current, previous) => previous > 0 ? Math.round(((current - previous) / previous) * 100) : 0
        const totalLives = toInt(liveOps.total_lives)
        const totalVideos = toInt(videoOps.total_videos)
        const totalConteudos = totalLives + totalVideos
        const gmvLives = round2(sales.gmv_lives)
        const gmvVideos = round2(sales.gmv_videos)
        const horasLive = round1(liveOps.horas_live)
        const pedidosLives = toInt(sales.pedidos_lives)
        const gmvPorLive = totalLives > 0 ? round2(gmvTotal / totalLives) : 0
        const gmvPorHora = horasLive > 0 ? round2(gmvTotal / horasLive) : 0
        const ticketMedioLive = pedidosLives > 0 ? round2(gmvLives / pedidosLives) : 0
        const hoursRows = hoursQ.rows
        const monthlyRows = monthlyQ.rows.map((row) => ({
          mes: row.mes,
          gmv: round2(row.gmv),
          gmv_total: round2(row.gmv),
          gmv_lives: round2(row.gmv_lives),
          gmv_videos: round2(row.gmv_videos),
          pedidos: toInt(row.pedidos),
          total_vendas: toInt(row.pedidos),
          total_lives: toInt(row.total_lives),
          total_videos: toInt(row.total_videos),
        }))
        const pedidosMensal = monthlyRows.map((row) => ({
          mes: row.mes,
          pedidos: row.pedidos,
          total_vendas: row.pedidos,
        }))

        const rankingApresentadoras = presenterRankingQ.map((row) => ({
          apresentadora_id: row.apresentadora_id,
          apresentador_id: row.apresentadora_id,
          apresentadora_nome: row.apresentadora_nome,
          apresentador_nome: row.apresentadora_nome,
          apresentadora_foto_url: row.apresentadora_foto_url,
          total_lives: toInt(row.total_lives),
          total_videos: toInt(row.total_videos),
          pedidos: toInt(row.pedidos),
          gmv_total: round2(row.gmv_total),
          gmv_lives: round2(row.gmv_lives),
          gmv_videos: round2(row.gmv_videos),
        }))

        const rankingMarcas = brandRankingQ.map((row) => ({
          marca_id: row.marca_id,
          marca_nome: row.marca_nome,
          nome: row.marca_nome,
          logo_url: row.logo_url,
          total_lives: toInt(row.total_lives),
          total_videos: toInt(row.total_videos),
          pedidos: toInt(row.pedidos),
          gmv_total: round2(row.gmv_total),
          gmv_lives: round2(row.gmv_lives),
          gmv_videos: round2(row.gmv_videos),
        }))

        return {
          periodo: { from: fromDate, to: toDate, mesAno },
          kpis: {
            gmv_total: gmvTotal,
            faturamento_total: gmvTotal,
            gmv_lives: gmvLives,
            gmv_videos: gmvVideos,
            pedidos_total: pedidosTotal,
            total_vendas: pedidosTotal,
            pedidos_lives: pedidosLives,
            pedidos_videos: toInt(sales.pedidos_videos),
            ticket_medio: ticketMedio,
            ticket_medio_live: ticketMedioLive,
            total_lives: totalLives,
            total_videos: totalVideos,
            total_conteudos: totalConteudos,
            registros_video: toInt(videoOps.registros_video),
            horas_live: horasLive,
            total_horas_no_ar: horasLive,
            gmv_por_live: gmvPorLive,
            gmv_por_hora: gmvPorHora,
            gmv_hora: gmvPorHora,
            viewers_total: toInt(liveOps.viewers_total),
            audiencia_media: totalLives > 0 ? Math.round(toInt(liveOps.viewers_total) / totalLives) : 0,
            likes_total: toInt(liveOps.likes_total),
            comentarios_total: toInt(liveOps.comentarios_total),
            shares_total: toInt(liveOps.shares_total),
            diamonds_total: toInt(liveOps.diamonds_total),
            delta_gmv: pct(gmvTotal, gmvPrev),
            delta_faturamento: pct(gmvTotal, gmvPrev),
            delta_pedidos: pct(pedidosTotal, pedidosPrev),
            delta_vendas: pct(pedidosTotal, pedidosPrev),
            delta_ticket: pct(ticketMedio, ticketPrev),
          },
          gmv_total: gmvTotal,
          gmv_mes: gmvTotal,
          gmv_lives: gmvLives,
          gmv_videos: gmvVideos,
          pedidos_total: pedidosTotal,
          pedidos: pedidosTotal,
          total_lives: totalLives,
          lives_realizadas: totalLives,
          total_videos: totalVideos,
          videos_gravados: totalVideos,
          total_conteudos: totalConteudos,
          horas_live: horasLive,
          ticket_medio: ticketMedio,
          ticket_medio_live: ticketMedioLive,
          gmv_por_live: gmvPorLive,
          gmv_por_hora: gmvPorHora,
          gmv_hora: gmvPorHora,
          viewers_total: toInt(liveOps.viewers_total),
          likes_total: toInt(liveOps.likes_total),
          comentarios_total: toInt(liveOps.comentarios_total),
          shares_total: toInt(liveOps.shares_total),
          diamonds_total: toInt(liveOps.diamonds_total),
          gmv_mensal: monthlyRows,
          faturamento_mensal: monthlyRows,
          pedidos_mensal: pedidosMensal,
          vendas_mensal: pedidosMensal,
          horas_live_por_dia: hoursRows.map((row) => ({
            dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
            horas: round1(row.horas),
            gmv_total: round2(row.gmv_lives),
            gmv_lives: round2(row.gmv_lives),
            pedidos: toInt(row.pedidos_lives),
          })),
          gmv_diario: hoursRows.map((row) => ({
            dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
            gmv_total: round2(row.gmv_lives),
            gmv_lives: round2(row.gmv_lives),
          })),
          pedidos_diario: hoursRows.map((row) => ({
            dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
            pedidos: toInt(row.pedidos_lives),
            total_pedidos: toInt(row.pedidos_lives),
          })),
          ranking_apresentadoras: rankingApresentadoras,
          ranking_apresentadores: rankingApresentadoras,
          ranking_marcas: rankingMarcas,

          peak_hours: peakHoursQ.rows.map((row) => ({
            hora: toInt(row.hora),
            total_lives: toInt(row.total_lives),
            gmv: round2(row.gmv),
          })),
          heatmap_conversao: heatmapQ.rows.map((row) => ({
            dow: toInt(row.dow),
            bloco_hora: toInt(row.bloco_hora),
            gmv: round2(row.gmv),
            lives: toInt(row.lives),
          })),
        }
      })
    } catch (err) {
      request.log.error({ err }, 'analytics/dashboard error')
      return reply.code(500).send({ error: err.message })
    }
  })

  // ── Funil de Lives (por Marca ou por Apresentadora) ────────────────────
  // Agrega métricas do TikTok Shop Ads (campos manuais) por período.
  // Aplica filtro: status=encerrada AND duration>=300s (5min).
  // Fórmulas do funil: ver doc de handoff (CONSOLIDADO_DIA_28).
  function mapFunilRow(row) {
    const gmv     = round2(row.gmv)
    const verba   = round2(row.verba)
    const horas   = round2(row.horas)
    const pedidos = toInt(row.pedidos)
    const views   = toInt(row.views)
    const comments = toInt(row.comments)
    const liveImpressions    = toInt(row.live_impressions)
    const productImpressions = toInt(row.product_impressions)
    const productClicks      = toInt(row.product_clicks)
    return {
      grupo_id:    row.grupo_id   ?? null,
      grupo_nome:  row.grupo_nome,
      logo_url:    row.logo_url   ?? null,
      total_lives: toInt(row.total_lives),
      gmv,
      verba,
      roi:       verba > 0   ? round2(gmv / verba)           : null,
      gmv_hora:  horas > 0   ? round2(gmv / horas)           : null,
      ticket:    pedidos > 0 ? round2(gmv / pedidos)          : null,
      pedidos,
      new_followers: toInt(row.new_followers),
      retencao:  row.retencao != null ? round2(row.retencao) : null,
      entrada:   liveImpressions > 0    ? round2(views    / liveImpressions)    : null,
      clique:    productImpressions > 0 ? round2(productClicks / productImpressions) : null,
      fecha:     productClicks > 0      ? round2(pedidos  / productClicks)      : null,
      coment:    views > 0              ? round2(comments / views)              : null,
    }
  }

  app.get('/v1/analytics/funil', {
    preHandler: [app.authenticate, app.requirePapel(READ_ANALYTICS)],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          mesAno:  { type: 'string' },
          mes:     { type: 'string' },
          ano:     { type: 'string' },
          groupBy: { type: 'string', enum: ['marca', 'apresentadora'] },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const groupBy = request.query?.groupBy ?? 'marca'
    if (!['marca', 'apresentadora'].includes(groupBy)) {
      return reply.code(400).send({ error: "groupBy must be 'marca' or 'apresentadora'" })
    }

    const period = resolveAnalyticsPeriod(request.query)
    if (period.error) return reply.code(400).send({ error: period.error })
    const { fromDate, toDate } = period

    try {
      return await app.withTenant(tenant_id, async (db) => {
        const params = [fromDate, toDate]
        const WHERE_BASE = `
          l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
          AND COALESCE(l.encerrado_em, l.previsto_fim) IS NOT NULL
          AND COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
          AND EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) >= 300
          AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= $1::date
          AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date <= $2::date
        `

        const AGG_COLS = `
          COUNT(*)::int AS total_lives,
          COALESCE(SUM(l.ads_gmv), 0) AS gmv,
          COALESCE(SUM(l.ads_cost), 0) AS verba,
          COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0), 0) AS horas,
          COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos,
          COALESCE(SUM(COALESCE(l.manual_views, l.final_peak_viewers, 0)), 0)::bigint AS views,
          COALESCE(SUM(COALESCE(l.manual_comments, l.final_total_comments, 0)), 0)::bigint AS comments,
          COALESCE(SUM(l.live_impressions), 0)::bigint AS live_impressions,
          COALESCE(SUM(l.product_impressions), 0)::bigint AS product_impressions,
          COALESCE(SUM(l.product_clicks), 0)::bigint AS product_clicks,
          AVG(NULLIF(l.avg_viewing_duration, 0)) AS retencao,
          COALESCE(SUM(l.new_followers), 0)::int AS new_followers
        `

        if (groupBy === 'marca') {
          const result = await db.query(`
            SELECT
              l.marca_id AS grupo_id,
              COALESCE(m.nome, 'Sem marca') AS grupo_nome,
              COALESCE(m.logo_url, cl.logo_url) AS logo_url,
              ${AGG_COLS}
            FROM lives l
            LEFT JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
            LEFT JOIN clientes cl ON cl.id = m.cliente_id AND cl.tenant_id = l.tenant_id
            WHERE ${WHERE_BASE}
            GROUP BY l.marca_id, COALESCE(m.nome, 'Sem marca'), COALESCE(m.logo_url, cl.logo_url)
            ORDER BY gmv DESC, total_lives DESC
          `, params)
          return result.rows.map(mapFunilRow)
        }

        // groupBy === 'apresentadora'
        const result = await db.query(`
          SELECT
            COALESCE(ap_v2.apresentadora_id, ap_user.id) AS grupo_id,
            COALESCE(ap_v2.nome, ap_user.nome, u.nome, 'Sem apresentadora') AS grupo_nome,
            COALESCE(ap_v2.foto_url, ap_user.foto_url) AS logo_url,
            ${AGG_COLS}
          FROM lives l
          LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
          LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
          LEFT JOIN LATERAL (
            SELECT lav.apresentadora_id, a.nome, a.foto_url
            FROM live_apresentadoras_v2 lav
            JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
            WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
            ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
            LIMIT 1
          ) ap_v2 ON true
          WHERE ${WHERE_BASE}
          GROUP BY
            COALESCE(ap_v2.apresentadora_id, ap_user.id),
            COALESCE(ap_v2.nome, ap_user.nome, u.nome, 'Sem apresentadora'),
            COALESCE(ap_v2.foto_url, ap_user.foto_url)
          ORDER BY gmv DESC, total_lives DESC
        `, params)
        return result.rows.map(mapFunilRow)
      })
    } catch (err) {
      request.log.error({ err }, 'analytics/funil error')
      return reply.code(500).send({ error: err.message })
    }
  })

  app.get('/v1/analytics/diario', {
    preHandler: [app.authenticate, app.requirePapel(READ_ANALYTICS)],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          mesAno: { type: 'string' },
          mes: { type: 'string' },
          ano: { type: 'string' },
          marca_id: { type: 'string' },
          apresentadora_id: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const period = resolveAnalyticsPeriod(request.query)
    if (period.error) return reply.code(400).send({ error: period.error })

    const marcaId = request.query?.marca_id ? String(request.query.marca_id) : null
    const apresentadoraId = request.query?.apresentadora_id ? String(request.query.apresentadora_id) : null
    if (marcaId && !UUID_RE.test(marcaId)) return reply.code(400).send({ error: 'marca_id must be a valid UUID' })
    if (apresentadoraId && !UUID_RE.test(apresentadoraId)) return reply.code(400).send({ error: 'apresentadora_id must be a valid UUID' })

    const { fromDate, toDate, mesAno } = period
    try {
      return await app.withTenant(tenant_id, async (db) => {
        const result = await db.query(`
          WITH live_base AS (
            SELECT
              (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS dia,
              l.marca_id,
              COALESCE(m.nome, 'Sem marca') AS marca_nome,
              COALESCE(ap_v2.apresentadora_id, ap_user.id) AS apresentadora_id,
              COALESCE(ap_v2.nome, ap_user.nome, u.nome, 'Sem apresentadora') AS apresentadora_nome,
              COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv,
              COALESCE(l.manual_orders, l.final_orders_count, 0)::int AS pedidos,
              CASE
                WHEN COALESCE(l.encerrado_em, l.previsto_fim) IS NOT NULL
                 AND COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
                  THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
                ELSE 0
              END AS horas
            FROM lives l
            LEFT JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
            LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
            LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
            LEFT JOIN LATERAL (
              SELECT lav.apresentadora_id, a.nome
              FROM live_apresentadoras_v2 lav
              JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
              WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
              ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
              LIMIT 1
            ) ap_v2 ON true
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= $1::date
              AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date <= $2::date
              AND ($3::uuid IS NULL OR l.marca_id = $3::uuid)
              AND ($4::uuid IS NULL OR COALESCE(ap_v2.apresentadora_id, ap_user.id) = $4::uuid)
          ),
          live_daily AS (
            SELECT
              dia,
              marca_id,
              marca_nome,
              apresentadora_id,
              apresentadora_nome,
              COUNT(*)::int AS total_lives,
              COALESCE(SUM(gmv), 0) AS gmv_lives,
              COALESCE(SUM(pedidos), 0)::int AS pedidos_lives,
              COALESCE(SUM(horas), 0) AS horas_live
            FROM live_base
            GROUP BY dia, marca_id, marca_nome, apresentadora_id, apresentadora_nome
          ),
          video_daily AS (
            SELECT
              va.data::date AS dia,
              va.marca_id,
              COALESCE(m.nome, 'Sem marca') AS marca_nome,
              va.apresentadora_id,
              COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome,
              COALESCE(SUM(va.gmv), 0) AS gmv_videos,
              COALESCE(SUM(va.pedidos), 0)::int AS pedidos_videos,
              COUNT(DISTINCT va.origem_id)::int AS total_videos
            FROM vendas_atribuidas va
            LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
            LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
            WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND va.origem = 'video'
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
              AND va.data >= $1::date
              AND va.data <= $2::date
              AND ($3::uuid IS NULL OR va.marca_id = $3::uuid)
              AND ($4::uuid IS NULL OR va.apresentadora_id = $4::uuid)
            GROUP BY va.data::date, va.marca_id, COALESCE(m.nome, 'Sem marca'), va.apresentadora_id, COALESCE(a.nome, 'Sem apresentadora')
          )
          SELECT
            COALESCE(ld.dia, vd.dia) AS dia,
            COALESCE(ld.marca_id, vd.marca_id) AS marca_id,
            COALESCE(ld.marca_nome, vd.marca_nome, 'Sem marca') AS marca_nome,
            COALESCE(ld.apresentadora_id, vd.apresentadora_id) AS apresentadora_id,
            COALESCE(ld.apresentadora_nome, vd.apresentadora_nome, 'Sem apresentadora') AS apresentadora_nome,
            COALESCE(ld.total_lives, 0)::int AS total_lives,
            COALESCE(vd.total_videos, 0)::int AS total_videos,
            COALESCE(ld.gmv_lives, 0) AS gmv_lives,
            COALESCE(vd.gmv_videos, 0) AS gmv_videos,
            COALESCE(ld.horas_live, 0) AS horas_live,
            (COALESCE(ld.pedidos_lives, 0) + COALESCE(vd.pedidos_videos, 0))::int AS pedidos
          FROM live_daily ld
          FULL OUTER JOIN video_daily vd
            ON vd.dia = ld.dia
           AND vd.marca_id IS NOT DISTINCT FROM ld.marca_id
           AND vd.apresentadora_id IS NOT DISTINCT FROM ld.apresentadora_id
          WHERE
            COALESCE(ld.total_lives, 0) > 0
            OR COALESCE(vd.total_videos, 0) > 0
            OR COALESCE(ld.gmv_lives, 0) > 0
            OR COALESCE(vd.gmv_videos, 0) > 0
            OR COALESCE(ld.horas_live, 0) > 0
            OR (COALESCE(ld.pedidos_lives, 0) + COALESCE(vd.pedidos_videos, 0)) > 0
          ORDER BY dia ASC, marca_nome ASC, apresentadora_nome ASC
        `, [fromDate, toDate, marcaId, apresentadoraId])

        return {
          periodo: { from: fromDate, to: toDate, mesAno },
          filters: { marca_id: marcaId, apresentadora_id: apresentadoraId },
          rows: result.rows.map((row) => {
            const gmvLives = round2(row.gmv_lives)
            const gmvVideos = round2(row.gmv_videos)
            const gmvTotal = round2(gmvLives + gmvVideos)
            const totalLives = toInt(row.total_lives)
            const horasLive = round1(row.horas_live)
            const pedidos = toInt(row.pedidos)
            return {
              dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
              marca_id: row.marca_id ?? null,
              marca_nome: row.marca_nome ?? 'Sem marca',
              apresentadora_id: row.apresentadora_id ?? null,
              apresentadora_nome: row.apresentadora_nome ?? 'Sem apresentadora',
              gmv_total: gmvTotal,
              gmv_lives: gmvLives,
              gmv_videos: gmvVideos,
              total_lives: totalLives,
              total_videos: toInt(row.total_videos),
              horas_live: horasLive,
              gmv_por_live: totalLives > 0 ? round2(gmvTotal / totalLives) : 0,
              gmv_por_hora: horasLive > 0 ? round2(gmvTotal / horasLive) : 0,
              pedidos,
              ticket_medio: pedidos > 0 ? round2(gmvTotal / pedidos) : 0,
            }
          }),
        }
      })
    } catch (err) {
      request.log.error({ err }, 'analytics/diario error')
      return reply.code(500).send({ error: err.message })
    }
  })
}
