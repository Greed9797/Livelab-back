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
          cliente_id: { type: 'string', format: 'uuid' },
          mesAno: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        },
      },
    },
  }, async (request) => {
    const { tenant_id } = request.user
    const { cliente_id, mesAno } = request.query
    const refDate = mesAno ? `${mesAno}-01` : new Date().toISOString().slice(0, 8) + '01'

    const clienteFilter = cliente_id ? 'AND l.cliente_id = $2' : ''
    const params = cliente_id ? [refDate, cliente_id] : [refDate]

    return app.withTenant(tenant_id, async (db) => {
      const [faturamentoQ, vendasQ, horasQ, rankingQ] = await Promise.all([
        // Query A — Faturamento Mensal (últimos 12 meses)
        db.query(`
          SELECT
            to_char(date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
            COALESCE(SUM(l.fat_gerado), 0) AS gmv
          FROM lives l
          WHERE l.status = 'encerrada'
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' >= date_trunc('month', $1::date) - interval '11 months'
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' <  date_trunc('month', $1::date) + interval '1 month'
            ${clienteFilter}
          GROUP BY 1 ORDER BY 1
        `, params),

        // Query B — Vendas Mensal (últimos 12 meses)
        db.query(`
          SELECT
            to_char(date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes,
            COUNT(*) AS total_vendas
          FROM lives l
          WHERE l.status = 'encerrada'
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' >= date_trunc('month', $1::date) - interval '11 months'
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' <  date_trunc('month', $1::date) + interval '1 month'
            ${clienteFilter}
          GROUP BY 1 ORDER BY 1
        `, params),

        // Query C — Horas de Live por Dia (últimos 30 dias do período)
        db.query(`
          SELECT
            (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
            COALESCE(SUM(
              EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, NOW()) - l.iniciado_em)) / 3600.0
            ), 0) AS horas
          FROM lives l
          WHERE l.status IN ('encerrada', 'em_andamento')
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' >= date_trunc('month', $1::date) + interval '1 month' - interval '30 days'
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' <  date_trunc('month', $1::date) + interval '1 month'
            ${clienteFilter}
          GROUP BY 1 ORDER BY 1
        `, params),

        // Query D — Ranking Top 10 Apresentadores (mês selecionado)
        db.query(`
          SELECT
            l.apresentador_id,
            u.nome AS apresentador_nome,
            COUNT(*) AS total_lives,
            COALESCE(SUM(l.fat_gerado), 0) AS gmv_total
          FROM lives l
          JOIN users u ON u.id = l.apresentador_id
          WHERE l.status = 'encerrada'
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' >= date_trunc('month', $1::date)
            AND l.iniciado_em AT TIME ZONE 'America/Sao_Paulo' <  date_trunc('month', $1::date) + interval '1 month'
            ${clienteFilter}
          GROUP BY l.apresentador_id, u.nome
          ORDER BY gmv_total DESC
          LIMIT 10
        `, params),
      ])

      const faturamentoRows = faturamentoQ.rows
      const vendasRows = vendasQ.rows
      const horasRows = horasQ.rows
      const rankingRows = rankingQ.rows

      // Derivar KPIs do mês selecionado
      const mesAlvo = mesAno || new Date().toISOString().slice(0, 7)
      const fatMesAtual = faturamentoRows.find(r => r.mes === mesAlvo)
      const vendasMesAtual = vendasRows.find(r => r.mes === mesAlvo)

      const faturamentoTotal = parseFloat(Number(fatMesAtual?.gmv ?? 0).toFixed(2))
      const totalVendas = Number(vendasMesAtual?.total_vendas ?? 0)
      // Proteção contra divisão por zero: retorna 0 quando totalVendas é 0
      const ticketMedio = totalVendas > 0
        ? parseFloat((faturamentoTotal / totalVendas).toFixed(2))
        : 0

      return {
        kpis: {
          faturamento_total: faturamentoTotal,
          total_vendas: totalVendas,
          ticket_medio: ticketMedio,
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
      }
    })
  })
}
