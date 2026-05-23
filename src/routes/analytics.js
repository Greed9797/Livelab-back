import { READ_ANALYTICS } from '../config/role_groups.js'

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

export async function analyticsRoutes(app) {
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
          COALESCE(SUM(l.fat_gerado), 0) AS gmv_total
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
          COALESCE(SUM(l.fat_gerado), 0) AS gmv_total,
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
          COALESCE(SUM(l.fat_gerado), 0) AS gmv_total
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
          COALESCE(SUM(l.fat_gerado), 0) AS gmv_acumulado
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
            SELECT
              COALESCE(SUM(va.gmv), 0) AS gmv_total,
              COALESCE(SUM(va.gmv) FILTER (WHERE va.origem = 'live'), 0) AS gmv_lives,
              COALESCE(SUM(va.gmv) FILTER (WHERE va.origem = 'video'), 0) AS gmv_videos,
              COALESCE(SUM(va.pedidos), 0)::int AS pedidos_total,
              COALESCE(SUM(va.pedidos) FILTER (WHERE va.origem = 'live'), 0)::int AS pedidos_lives,
              COALESCE(SUM(va.pedidos) FILTER (WHERE va.origem = 'video'), 0)::int AS pedidos_videos
            FROM vendas_atribuidas va
            ${clienteSalesJoin}
            WHERE ${salesWhere}
          `, params),

          db.query(`
            SELECT
              COALESCE(SUM(va.gmv), 0) AS gmv_total,
              COALESCE(SUM(va.pedidos), 0)::int AS pedidos_total
            FROM vendas_atribuidas va
            ${clienteSalesJoin}
            WHERE ${salesWhere}
          `, prevParams),

          db.query(`
            SELECT
              COUNT(*)::int AS total_lives,
              COALESCE(SUM(
                CASE
                  WHEN l.encerrado_em IS NOT NULL AND l.encerrado_em > l.iniciado_em
                    THEN LEAST(EXTRACT(EPOCH FROM (l.encerrado_em - l.iniciado_em)) / 3600.0, 24.0)
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
            WITH analytics_months AS (
              SELECT generate_series(
                date_trunc('month', $2::date) - interval '11 months',
                date_trunc('month', $2::date),
                interval '1 month'
              )::date AS mes_inicio
            ),
            sales AS (
              SELECT
                date_trunc('month', va.data)::date AS mes_inicio,
                COALESCE(SUM(va.gmv), 0) AS gmv_total,
                COALESCE(SUM(va.gmv) FILTER (WHERE va.origem = 'live'), 0) AS gmv_lives,
                COALESCE(SUM(va.gmv) FILTER (WHERE va.origem = 'video'), 0) AS gmv_videos,
                COALESCE(SUM(va.pedidos), 0)::int AS pedidos_total
              FROM vendas_atribuidas va
              ${clienteSalesJoin}
              WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND va.origem IN ('live', 'video')
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
              COALESCE(s.gmv_total, 0) AS gmv,
              COALESCE(s.gmv_lives, 0) AS gmv_lives,
              COALESCE(s.gmv_videos, 0) AS gmv_videos,
              COALESCE(s.pedidos_total, 0)::int AS pedidos,
              COALESCE(l.total_lives, 0)::int AS total_lives,
              COALESCE(v.total_videos, 0)::int AS total_videos
            FROM analytics_months m
            LEFT JOIN sales s ON s.mes_inicio = m.mes_inicio
            LEFT JOIN lives_ops l ON l.mes_inicio = m.mes_inicio
            LEFT JOIN videos_ops v ON v.mes_inicio = m.mes_inicio
            ORDER BY m.mes_inicio ASC
          `, params),

          db.query(`
            SELECT
              (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS dia,
              COALESCE(SUM(
                CASE
                  WHEN l.encerrado_em IS NOT NULL AND l.encerrado_em > l.iniciado_em
                    THEN LEAST(EXTRACT(EPOCH FROM (l.encerrado_em - l.iniciado_em)) / 3600.0, 24.0)
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

          db.query(`
            SELECT
              va.apresentadora_id,
              COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome,
              a.foto_url AS apresentadora_foto_url,
              COALESCE(SUM(va.gmv), 0) AS gmv_total,
              COALESCE(SUM(va.gmv) FILTER (WHERE va.origem = 'live'), 0) AS gmv_lives,
              COALESCE(SUM(va.gmv) FILTER (WHERE va.origem = 'video'), 0) AS gmv_videos,
              COALESCE(SUM(va.pedidos), 0)::int AS pedidos,
              COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'live')::int AS total_lives,
              COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'video')::int AS total_videos
            FROM vendas_atribuidas va
            JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
            LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
            WHERE ${salesWhere}
              ${clienteMarcaFilter}
            GROUP BY va.apresentadora_id, a.nome, a.foto_url
            HAVING COALESCE(SUM(va.gmv), 0) <> 0 OR COALESCE(SUM(va.pedidos), 0) <> 0
            ORDER BY gmv_total DESC, pedidos DESC, apresentadora_nome ASC
            LIMIT 10
          `, params),

          db.query(`
            SELECT
              va.marca_id,
              m.nome AS marca_nome,
              COALESCE(m.logo_url, c.logo_url) AS logo_url,
              COALESCE(SUM(va.gmv), 0) AS gmv_total,
              COALESCE(SUM(va.gmv) FILTER (WHERE va.origem = 'live'), 0) AS gmv_lives,
              COALESCE(SUM(va.gmv) FILTER (WHERE va.origem = 'video'), 0) AS gmv_videos,
              COALESCE(SUM(va.pedidos), 0)::int AS pedidos,
              COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'live')::int AS total_lives,
              COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'video')::int AS total_videos
            FROM vendas_atribuidas va
            JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
            LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
            WHERE ${salesWhere}
              ${clienteMarcaFilter}
            GROUP BY va.marca_id, m.nome, COALESCE(m.logo_url, c.logo_url)
            HAVING COALESCE(SUM(va.gmv), 0) <> 0 OR COALESCE(SUM(va.pedidos), 0) <> 0
            ORDER BY gmv_total DESC, pedidos DESC, marca_nome ASC
            LIMIT 10
          `, params),

          db.query(`
            SELECT
              EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::int AS hora,
              COUNT(*)::int AS total_lives,
              COALESCE(SUM(COALESCE(l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv
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
              COALESCE(SUM(COALESCE(l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv
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

        const rankingApresentadoras = presenterRankingQ.rows.map((row) => ({
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

        const rankingMarcas = brandRankingQ.rows.map((row) => ({
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
            gmv_lives: round2(sales.gmv_lives),
            gmv_videos: round2(sales.gmv_videos),
            pedidos_total: pedidosTotal,
            total_vendas: pedidosTotal,
            pedidos_lives: toInt(sales.pedidos_lives),
            pedidos_videos: toInt(sales.pedidos_videos),
            ticket_medio: ticketMedio,
            total_lives: totalLives,
            total_videos: totalVideos,
            total_conteudos: totalConteudos,
            registros_video: toInt(videoOps.registros_video),
            horas_live: round1(liveOps.horas_live),
            total_horas_no_ar: round1(liveOps.horas_live),
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
          gmv_lives: round2(sales.gmv_lives),
          gmv_videos: round2(sales.gmv_videos),
          pedidos_total: pedidosTotal,
          pedidos: pedidosTotal,
          total_lives: totalLives,
          lives_realizadas: totalLives,
          total_videos: totalVideos,
          videos_gravados: totalVideos,
          total_conteudos: totalConteudos,
          horas_live: round1(liveOps.horas_live),
          ticket_medio: ticketMedio,
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
}
