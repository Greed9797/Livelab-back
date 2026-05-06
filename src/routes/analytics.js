export async function analyticsRoutes(app) {
  app.get('/v1/analytics/franqueado/resumo', {
    preHandler: [
      app.authenticate,
      app.requirePapel(['franqueado', 'gerente']),
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
        db.query(`
        WITH lives_ao_vivo AS (
          SELECT c.live_atual_id AS live_id
          FROM cabines c
          WHERE c.status = 'ao_vivo'
            AND c.live_atual_id IS NOT NULL
        ), snapshots_recentes AS (
          SELECT DISTINCT ON (ls.live_id)
                 ls.live_id,
                 ls.viewer_count,
                 ls.gmv
          FROM live_snapshots ls
          JOIN lives_ao_vivo laov ON laov.live_id = ls.live_id
          ORDER BY ls.live_id, ls.captured_at DESC
        )
        SELECT
          COALESCE(SUM(sr.gmv), 0) AS gmv_total_hoje,
          COALESCE(SUM(sr.viewer_count), 0) AS audiencia_total_ao_vivo,
          (
            SELECT COUNT(*)
            FROM lives l
            WHERE l.status = 'encerrada'
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
        WHERE l.status = 'encerrada'
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
        JOIN clientes c ON c.id = l.cliente_id
        WHERE l.status = 'encerrada'
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
        WHERE l.status = 'encerrada'
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
         AND l.status = 'encerrada'
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
      app.requirePapel(['franqueado', 'gerente']),
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          cliente_id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          mesAno: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { cliente_id, from, to, mesAno } = request.query

    // Basic date format validation (YYYY-MM-DD)
    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
      return reply.code(400).send({ error: 'from/to must be YYYY-MM-DD' })
    }

    // Resolver range — prioridade: from+to > mesAno > default (últimos 30 dias)
    let fromDate, toDate
    if (from && to) {
      fromDate = from
      toDate = to
    } else if (mesAno) {
      fromDate = `${mesAno}-01`
      const [y, m] = mesAno.split('-').map(Number)
      toDate = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    } else {
      const now = new Date()
      toDate = now.toISOString().slice(0, 10)
      const past = new Date(now)
      past.setDate(past.getDate() - 29)
      fromDate = past.toISOString().slice(0, 10)
    }

    // Janela anterior de mesmo tamanho (para deltas)
    const dayMs = 86400000
    const days = Math.floor((new Date(toDate) - new Date(fromDate)) / dayMs) + 1
    const prevToD = new Date(fromDate); prevToD.setDate(prevToD.getDate() - 1)
    const prevFromD = new Date(prevToD); prevFromD.setDate(prevFromD.getDate() - days + 1)
    const prevFrom = prevFromD.toISOString().slice(0, 10)
    const prevTo = prevToD.toISOString().slice(0, 10)

    const clienteFilter = cliente_id ? 'AND l.cliente_id = $3' : ''
    const params = cliente_id ? [fromDate, toDate, cliente_id] : [fromDate, toDate]
    const prevParams = cliente_id ? [prevFrom, prevTo, cliente_id] : [prevFrom, prevTo]

    try {
    return await app.withTenant(tenant_id, async (db) => {
      // Filtro de range explícito (do parâmetro)
      const rangeFilter = `
        AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' >= $1::date
        AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' <  ($2::date + interval '1 day')
      `

      const [
        faturamentoQ, vendasQ, horasQ, rankingQ,
        peakHoursQ, heatmapQ, audienciaQ,
        kpisCurQ, kpisPrevQ,
      ] = await Promise.all([
        // Query A — Faturamento Mensal (12 meses ancorados em $2 = toDate)
        db.query(`
          SELECT
            to_char(date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
            COALESCE(SUM(l.fat_gerado), 0) AS gmv
          FROM lives l
          WHERE l.status = 'encerrada'
            AND $1::date IS NOT NULL
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' >= date_trunc('month', $2::date) - interval '11 months'
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' <  date_trunc('month', $2::date) + interval '1 month'
            ${clienteFilter}
          GROUP BY 1 ORDER BY 1
        `, params),

        // Query B — Vendas Mensal (12 meses ancorados em $2 = toDate)
        db.query(`
          SELECT
            to_char(date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
            COUNT(*) AS total_vendas
          FROM lives l
          WHERE l.status = 'encerrada'
            AND $1::date IS NOT NULL
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' >= date_trunc('month', $2::date) - interval '11 months'
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' <  date_trunc('month', $2::date) + interval '1 month'
            ${clienteFilter}
          GROUP BY 1 ORDER BY 1
        `, params),

        // Query C — Horas de Live por Dia (range completo)
        db.query(`
          SELECT
            (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
            COALESCE(SUM(
              EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, NOW()) - l.iniciado_em)) / 3600.0
            ), 0) AS horas
          FROM lives l
          WHERE l.status IN ('encerrada', 'em_andamento')
            ${rangeFilter}
            ${clienteFilter}
          GROUP BY 1 ORDER BY 1
        `, params),

        // Query D — Ranking Top 10 Apresentadores (range)
        db.query(`
          SELECT
            l.apresentador_id,
            u.nome AS apresentador_nome,
            COUNT(*) AS total_lives,
            COALESCE(SUM(l.fat_gerado), 0) AS gmv_total
          FROM lives l
          JOIN users u ON u.id = l.apresentador_id
          WHERE l.status = 'encerrada'
            ${rangeFilter}
            ${clienteFilter}
          GROUP BY l.apresentador_id, u.nome
          ORDER BY gmv_total DESC
          LIMIT 10
        `, params),

        // Query E — Horários de pico (GMV por hora do dia, range)
        db.query(`
          SELECT
            EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
            COALESCE(SUM(l.fat_gerado), 0) AS gmv
          FROM lives l
          WHERE l.status = 'encerrada'
            ${rangeFilter}
            ${clienteFilter}
          GROUP BY 1 ORDER BY 1
        `, params),

        // Query F — Heatmap conversão (dia da semana × bloco de 3h, range)
        db.query(`
          SELECT
            EXTRACT(ISODOW FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
            (FLOOR(EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo') / 3) * 3)::int AS bloco_hora,
            COALESCE(SUM(l.fat_gerado), 0) AS gmv,
            COUNT(*) AS lives
          FROM lives l
          WHERE l.status = 'encerrada'
            ${rangeFilter}
            ${clienteFilter}
          GROUP BY 1, 2 ORDER BY 1, 2
        `, params),

        // Query G — Audiência média via live_snapshots (range)
        db.query(`
          SELECT COALESCE(AVG(s.peak_viewers), 0) AS audiencia_media
          FROM (
            SELECT MAX(ls.viewer_count) AS peak_viewers
            FROM live_snapshots ls
            JOIN lives l ON l.id = ls.live_id
            WHERE l.status = 'encerrada'
              ${rangeFilter}
              ${clienteFilter}
            GROUP BY ls.live_id
          ) s
        `, params),

        // Query H — KPIs no range atual
        db.query(`
          SELECT
            COALESCE(SUM(l.fat_gerado), 0) AS faturamento_total,
            COUNT(*) AS total_vendas
          FROM lives l
          WHERE l.status = 'encerrada'
            ${rangeFilter}
            ${clienteFilter}
        `, params),

        // Query I — KPIs no range anterior (para deltas)
        db.query(`
          SELECT
            COALESCE(SUM(l.fat_gerado), 0) AS faturamento_total,
            COUNT(*) AS total_vendas
          FROM lives l
          WHERE l.status = 'encerrada'
            ${rangeFilter}
            ${clienteFilter}
        `, prevParams),
      ])

      const faturamentoRows = faturamentoQ.rows
      const vendasRows = vendasQ.rows
      const horasRows = horasQ.rows
      const rankingRows = rankingQ.rows
      const peakHoursRows = peakHoursQ.rows
      const heatmapRows = heatmapQ.rows
      const audienciaMedia = parseFloat(Number(audienciaQ.rows[0]?.audiencia_media ?? 0).toFixed(0))

      // KPIs do range atual
      const cur = kpisCurQ.rows[0] || {}
      const faturamentoTotal = parseFloat(Number(cur.faturamento_total ?? 0).toFixed(2))
      const totalVendas = Number(cur.total_vendas ?? 0)
      const ticketMedio = totalVendas > 0
        ? parseFloat((faturamentoTotal / totalVendas).toFixed(2))
        : 0

      // KPIs janela anterior
      const prev = kpisPrevQ.rows[0] || {}
      const fatAnt = Number(prev.faturamento_total ?? 0)
      const vendasAnt = Number(prev.total_vendas ?? 0)
      const ticketAnt = vendasAnt > 0 ? fatAnt / vendasAnt : 0

      const pct = (curV, prevV) => prevV > 0 ? Math.round(((curV - prevV) / prevV) * 100) : 0

      // Total horas no ar (range)
      const totalHoras = horasRows.reduce((acc, r) => acc + Number(r.horas), 0)

      return {
        kpis: {
          faturamento_total: faturamentoTotal,
          total_vendas: totalVendas,
          ticket_medio: ticketMedio,
          audiencia_media: audienciaMedia,
          delta_faturamento: pct(faturamentoTotal, fatAnt),
          delta_vendas: pct(totalVendas, vendasAnt),
          delta_ticket: pct(ticketMedio, ticketAnt),
          delta_audiencia: 0,
          total_horas_no_ar: parseFloat(totalHoras.toFixed(1)),
        },
        faturamento_mensal: faturamentoRows.map(r => ({
          mes: r.mes,
          gmv: parseFloat(Number(r.gmv).toFixed(2)),
        })),
        vendas_mensal: vendasRows.map(r => ({
          mes: r.mes,
          total_vendas: Number(r.total_vendas),
        })),
        horas_live_por_dia: horasRows.map(r => ({
          dia: typeof r.dia === 'string' ? r.dia : r.dia.toISOString().slice(0, 10),
          horas: parseFloat(Number(r.horas).toFixed(1)),
        })),
        ranking_apresentadores: rankingRows.map(r => ({
          apresentador_id: r.apresentador_id,
          apresentador_nome: r.apresentador_nome,
          total_lives: Number(r.total_lives),
          gmv_total: parseFloat(Number(r.gmv_total).toFixed(2)),
        })),
        peak_hours: peakHoursRows.map(r => ({
          hora: Number(r.hora),
          gmv: parseFloat(Number(r.gmv).toFixed(2)),
        })),
        heatmap_conversao: heatmapRows.map(r => ({
          dow: Number(r.dow),
          bloco_hora: Number(r.bloco_hora),
          gmv: parseFloat(Number(r.gmv).toFixed(2)),
          lives: Number(r.lives),
        })),
      }
    })
    } catch (err) {
      request.log.error({ err }, 'analytics/dashboard error')
      return reply.code(500).send({ error: err.message })
    }
  })
}
