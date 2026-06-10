import { calcularStatusOperacional } from '../services/status_operacional.js'
import { isFimDeSemanaSP } from '../services/comissao.js'
import { gerarRelatorioOperacionalPdf } from '../services/relatorio_pdf.js'

const DASHBOARD_TZ = 'America/Sao_Paulo'

function toNumber(value) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function toInt(value) {
  return Math.round(toNumber(value))
}

function round2(value) {
  return Number(toNumber(value).toFixed(2))
}

function parsePeriodo(query = {}) {
  const now = new Date()
  const mes = Number.parseInt(query.mes, 10)
  const ano = Number.parseInt(query.ano, 10)

  return {
    mes: mes >= 1 && mes <= 12 ? mes : now.getMonth() + 1,
    ano: ano >= 2000 && ano <= 2100 ? ano : now.getFullYear(),
  }
}

function calcularCustoHora(contrato) {
  const valorContrato = toNumber(contrato?.valor_fixo)
  const valorPacote = toNumber(contrato?.pacote_valor)
  const horasContrato = toNumber(contrato?.horas_contratadas)
  const horasPacote = toNumber(contrato?.horas_incluidas)

  const valorBase = valorContrato > 0 ? valorContrato : valorPacote
  const horasBase = horasContrato > 0 ? horasContrato : horasPacote

  return valorBase > 0 && horasBase > 0 ? valorBase / horasBase : 0
}

function emptyLivesPayload(periodo) {
  return {
    periodo,
    resumo: {
      total_faturamento: 0,
      gmv_total: 0,
      total_vendas: 0,
      itens_vendidos: 0,
      total_lives: 0,
      horas_live: 0,
      valor_investido_lives: 0,
      roas: 0,
      viewers: 0,
      comentarios: 0,
      likes: 0,
      shares: 0,
      pedidos: 0,
    },
    lives: [],
  }
}

function emptyDashboard(periodo) {
  return {
    periodo,
    faturamento_mes: 0,
    gmv_mes: 0,
    crescimento_pct: 0,
    volume_vendas: 0,
    itens_vendidos: 0,
    lucro_estimado: 0,
    horas_live_mes: 0,
    horas_live: 0,
    valor_investido_lives: 0,
    roas: 0,
    viewers: 0,
    comentarios: 0,
    likes: 0,
    shares: 0,
    pedidos: 0,
    total_lives: 0,
    live_ativa: null,
    mais_vendidos: [],
    ranking_dia: null,
    ranking_periodo: null,
    proxima_reserva: null,
    benchmark_nicho: null,
    benchmark_geral: null,
    melhores_horarios_venda: [],
    series_mensais: [],
    lives: [],
  }
}

function buildBenchmark({ niche, meuGmv, mediaGmv, amostra, percentil, minimumSample }) {
  const media = toNumber(mediaGmv)
  const sampleSize = toInt(amostra)

  if (sampleSize < minimumSample) {
    return null
  }

  const meu = toNumber(meuGmv)
  const percentualDaMedia = media > 0 ? round2((meu / media) * 100) : 0

  return {
    nicho: niche,
    meu_gmv: round2(meu),
    media_gmv: round2(media),
    percentual_da_media: percentualDaMedia,
    percentil: percentil == null ? null : round2(percentil),
    amostra: sampleSize,
    acima_da_media: meu > media,
  }
}

async function getClienteVinculado(db, tenantId, userId) {
  const userQ = await db.query(
    `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  )
  const email = userQ.rows[0]?.email

  if (!email) {
    return null
  }

  const clienteQ = await db.query(
    `SELECT id, nicho, nome
     FROM clientes
     WHERE tenant_id = $1
       AND email = $2
       AND status = 'ativo'
     LIMIT 1`,
    [tenantId, email]
  )

  return clienteQ.rows[0] ?? null
}

async function getContratoAtivo(db, tenantId, clienteId) {
  const contratoQ = await db.query(`
    SELECT
      c.id,
      c.comissao_pct,
      c.valor_fixo,
      c.horas_contratadas,
      c.ativado_em,
      c.assinado_em,
      p.valor AS pacote_valor,
      p.horas_incluidas
    FROM contratos c
    LEFT JOIN pacotes p ON p.id = c.pacote_id AND p.tenant_id = c.tenant_id
    WHERE c.tenant_id = $1
      AND c.cliente_id = $2
      AND c.status = 'ativo'
    ORDER BY c.ativado_em DESC NULLS LAST, c.criado_em DESC
    LIMIT 1
  `, [tenantId, clienteId])

  return contratoQ.rows[0] ?? null
}

async function fetchClienteLives(db, tenantId, clienteId, periodo, custoHora) {
  const livesQ = await db.query(`
    WITH periodo AS (
      SELECT
        make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') AS inicio,
        make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') + INTERVAL '1 month' AS fim
    )
    SELECT
      l.id,
      l.iniciado_em,
      l.encerrado_em,
      c.numero AS cabine_numero,
      u.nome AS apresentador_nome,
      l.status,
      COALESCE(l.fat_gerado, 0) AS total_faturamento,
      COALESCE(l.comissao_calculada, 0) AS comissao,
      COALESCE(prod.itens, 0) AS total_vendas,
      COALESCE(l.final_orders_count, snap.total_orders, prod.itens, 0) AS pedidos,
      COALESCE(l.final_peak_viewers, snap.peak_viewers, snap.total_viewers, 0) AS viewers,
      COALESCE(l.final_total_comments, snap.comments_count, 0) AS comentarios,
      COALESCE(l.final_total_likes, snap.likes_count, 0) AS likes,
      COALESCE(l.final_total_shares, snap.shares_count, 0) AS shares,
      GREATEST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, NOW()) - l.iniciado_em)) / 60, 0) AS duracao_min
    FROM lives l
    CROSS JOIN periodo p
    LEFT JOIN cabines c ON c.id = l.cabine_id
    LEFT JOIN users u ON u.id = l.apresentador_id
    LEFT JOIN LATERAL (
      SELECT SUM(lp.quantidade) AS itens
      FROM live_products lp
      WHERE lp.live_id = l.id
    ) prod ON true
    LEFT JOIN LATERAL (
      SELECT
        MAX(ls.viewer_count) AS peak_viewers,
        MAX(ls.total_viewers) AS total_viewers,
        MAX(ls.total_orders) AS total_orders,
        MAX(ls.likes_count) AS likes_count,
        MAX(ls.comments_count) AS comments_count,
        MAX(ls.shares_count) AS shares_count
      FROM live_snapshots ls
      WHERE ls.live_id = l.id
    ) snap ON true
    WHERE l.tenant_id = $1
      AND l.cliente_id = $2
      AND l.status IN ('encerrada', 'em_andamento')
      AND l.iniciado_em >= p.inicio
      AND l.iniciado_em < p.fim
    ORDER BY l.iniciado_em DESC
  `, [tenantId, clienteId, periodo.ano, periodo.mes])

  const lives = livesQ.rows.map((r) => {
    const gmv = round2(r.total_faturamento)
    const duracaoMin = Math.round(toNumber(r.duracao_min))
    const duracaoHoras = round2(duracaoMin / 60)
    const valorInvestido = round2(duracaoHoras * custoHora)

    return {
      id: r.id,
      iniciado_em: r.iniciado_em,
      encerrado_em: r.encerrado_em,
      cabine_numero: r.cabine_numero == null ? null : Number(r.cabine_numero),
      streamer_nome: r.apresentador_nome,
      status: r.status,
      total_faturamento: gmv,
      gmv,
      comissao: round2(r.comissao),
      total_vendas: toInt(r.total_vendas),
      itens_vendidos: toInt(r.total_vendas),
      pedidos: toInt(r.pedidos),
      duracao_min: duracaoMin,
      duracao_horas: duracaoHoras,
      viewers: toInt(r.viewers),
      comentarios: toInt(r.comentarios),
      likes: toInt(r.likes),
      shares: toInt(r.shares),
      valor_investido: valorInvestido,
      roas: valorInvestido > 0 ? round2(gmv / valorInvestido) : 0,
    }
  })

  const resumo = lives.reduce((acc, live) => {
    acc.total_faturamento += live.gmv
    acc.gmv_total += live.gmv
    acc.total_vendas += live.total_vendas
    acc.itens_vendidos += live.itens_vendidos
    acc.horas_live += live.duracao_horas
    acc.valor_investido_lives += live.valor_investido
    acc.viewers += live.viewers
    acc.comentarios += live.comentarios
    acc.likes += live.likes
    acc.shares += live.shares
    acc.pedidos += live.pedidos
    return acc
  }, {
    total_faturamento: 0,
    gmv_total: 0,
    total_vendas: 0,
    itens_vendidos: 0,
    total_lives: lives.length,
    horas_live: 0,
    valor_investido_lives: 0,
    roas: 0,
    viewers: 0,
    comentarios: 0,
    likes: 0,
    shares: 0,
    pedidos: 0,
  })

  resumo.total_faturamento = round2(resumo.total_faturamento)
  resumo.gmv_total = round2(resumo.gmv_total)
  resumo.horas_live = round2(resumo.horas_live)
  resumo.valor_investido_lives = round2(resumo.valor_investido_lives)
  resumo.roas = resumo.valor_investido_lives > 0
    ? round2(resumo.gmv_total / resumo.valor_investido_lives)
    : 0

  return { periodo, resumo, lives }
}

const bloquearClienteCabines = async (_request, reply) => {
  return reply.code(403).send({ error: 'Cliente parceiro não tem acesso a cabines' })
}

export async function clienteDashboardRoutes(app) {
  // GET /v1/cliente/dashboard
  app.get('/v1/cliente/dashboard', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const periodo = parsePeriodo(request.query)
    const db = await app.dbTenant(tenant_id)

    try {
      const clienteAtual = await getClienteVinculado(db, tenant_id, user_id)
      const cliente_id = clienteAtual?.id
      const clienteNicho = clienteAtual?.nicho ?? null

      if (!cliente_id) {
        return emptyDashboard(periodo)
      }

      const contratoAtivo = await getContratoAtivo(db, tenant_id, cliente_id)
      const comissaoPct = toNumber(contratoAtivo?.comissao_pct)
      const custoHora = calcularCustoHora(contratoAtivo)
      const livesPayload = await fetchClienteLives(db, tenant_id, cliente_id, periodo, custoHora)
      const resumo = livesPayload.resumo

      const crescQ = await db.query(`
        WITH periodo AS (
          SELECT make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') AS inicio
        )
        SELECT
          COALESCE(SUM(CASE WHEN l.iniciado_em >= p.inicio AND l.iniciado_em < p.inicio + INTERVAL '1 month'
                            THEN l.fat_gerado END), 0) AS mes_atual,
          COALESCE(SUM(CASE WHEN l.iniciado_em >= p.inicio - INTERVAL '1 month' AND l.iniciado_em < p.inicio
                            THEN l.fat_gerado END), 0) AS mes_anterior
        FROM lives l
        CROSS JOIN periodo p
        WHERE l.tenant_id = $1
          AND l.cliente_id = $2
          AND l.status IN ('encerrada', 'em_andamento')
      `, [tenant_id, cliente_id, periodo.ano, periodo.mes])

      const c = crescQ.rows[0]
      const crescimento = toNumber(c?.mes_anterior) > 0
        ? Math.round(((toNumber(c.mes_atual) - toNumber(c.mes_anterior)) / toNumber(c.mes_anterior)) * 100)
        : 0

      const liveQ = await db.query(`
        SELECT
          l.id,
          l.iniciado_em,
          c.numero AS cabine_numero,
          COALESCE(ls.viewer_count, 0) AS viewer_count,
          COALESCE(ls.gmv, 0) AS gmv_atual,
          COALESCE(ls.total_orders, 0) AS pedidos,
          COALESCE(ls.likes_count, 0) AS likes,
          COALESCE(ls.comments_count, 0) AS comentarios,
          COALESCE(ls.shares_count, 0) AS shares
        FROM lives l
        JOIN cabines c ON c.id = l.cabine_id
        LEFT JOIN LATERAL (
          SELECT viewer_count, gmv, total_orders, likes_count, comments_count, shares_count
          FROM live_snapshots
          WHERE live_id = l.id
          ORDER BY captured_at DESC
          LIMIT 1
        ) ls ON true
        WHERE l.tenant_id = $1
          AND l.cliente_id = $2
          AND l.status = 'em_andamento'
        LIMIT 1
      `, [tenant_id, cliente_id])

      const liveRow = liveQ.rows[0]
      let liveAtiva = null

      if (liveRow) {
        const iniciadoEm = new Date(liveRow.iniciado_em)
        const duracaoMin = Math.floor((new Date() - iniciadoEm) / 1000 / 60)
        const gmvAtual = round2(liveRow.gmv_atual)

        liveAtiva = {
          cabine_numero: liveRow.cabine_numero,
          viewer_count: toInt(liveRow.viewer_count),
          gmv_atual: gmvAtual,
          comissao_projetada: round2(gmvAtual * (comissaoPct / 100)),
          duracao_min: duracaoMin,
          iniciou_em: iniciadoEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          pedidos: toInt(liveRow.pedidos),
          likes: toInt(liveRow.likes),
          comentarios: toInt(liveRow.comentarios),
          shares: toInt(liveRow.shares),
        }
      }

      const produtosQ = await db.query(`
        WITH periodo AS (
          SELECT
            make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') AS inicio,
            make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') + INTERVAL '1 month' AS fim
        )
        SELECT
          lp.produto_nome AS produto,
          SUM(lp.quantidade) AS qty,
          SUM(lp.valor_total) AS valor
        FROM live_products lp
        JOIN lives l ON l.id = lp.live_id
        CROSS JOIN periodo p
        WHERE l.tenant_id = $1
          AND l.cliente_id = $2
          AND l.iniciado_em >= p.inicio
          AND l.iniciado_em < p.fim
        GROUP BY lp.produto_nome
        ORDER BY qty DESC, valor DESC
        LIMIT 5
      `, [tenant_id, cliente_id, periodo.ano, periodo.mes])

      const maisVendidos = produtosQ.rows.map(p => ({
        produto: p.produto,
        qty: toInt(p.qty),
        valor: round2(p.valor),
      }))

      const rankQ = await db.query(`
        WITH periodo AS (
          SELECT
            make_timestamptz($2::int, $3::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') AS inicio,
            make_timestamptz($2::int, $3::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') + INTERVAL '1 month' AS fim
        ), ranked AS (
          SELECT
            l.cliente_id,
            SUM(l.fat_gerado) AS total,
            RANK() OVER (ORDER BY SUM(l.fat_gerado) DESC) AS posicao,
            COUNT(*) OVER() AS total_participantes
          FROM lives l
          CROSS JOIN periodo p
          WHERE l.tenant_id = $1
            AND l.status IN ('encerrada', 'em_andamento')
            AND l.iniciado_em >= p.inicio
            AND l.iniciado_em < p.fim
          GROUP BY l.cliente_id
        )
        SELECT * FROM ranked
      `, [tenant_id, periodo.ano, periodo.mes])

      const minhaPosicao = rankQ.rows.find(r => r.cliente_id === cliente_id)
      const rankingPeriodo = minhaPosicao
        ? {
            posicao: toInt(minhaPosicao.posicao),
            gmv_periodo: round2(minhaPosicao.total),
            gmv_dia: round2(minhaPosicao.total),
            total_participantes: toInt(minhaPosicao.total_participantes),
          }
        : null

      const benchmarkQ = await db.query(`
        WITH base_90_dias AS (
          SELECT
            l.cliente_id,
            c.nicho,
            COALESCE(SUM(l.fat_gerado), 0) AS gmv_total,
            COUNT(l.id) AS total_lives
          FROM lives l
          JOIN clientes c ON c.id = l.cliente_id
          WHERE l.tenant_id = $1
            AND l.status = 'encerrada'
            AND l.iniciado_em >= CURRENT_DATE - INTERVAL '90 days'
            AND c.status = 'ativo'
          GROUP BY l.cliente_id, c.nicho
        ), cliente_base AS (
          SELECT
            $2::uuid AS cliente_id,
            $3::text AS nicho,
            COALESCE((SELECT gmv_total FROM base_90_dias WHERE cliente_id = $2), 0)::numeric AS meu_gmv
        ), rank_base AS (
          SELECT cliente_id, nicho, gmv_total
          FROM base_90_dias
          UNION ALL
          SELECT cb.cliente_id, cb.nicho, cb.meu_gmv
          FROM cliente_base cb
          WHERE NOT EXISTS (
            SELECT 1 FROM base_90_dias b WHERE b.cliente_id = cb.cliente_id
          )
        ), ranked AS (
          SELECT
            rb.cliente_id,
            rb.nicho,
            rb.gmv_total,
            PERCENT_RANK() OVER (PARTITION BY rb.nicho ORDER BY rb.gmv_total) AS percentil_nicho,
            PERCENT_RANK() OVER (ORDER BY rb.gmv_total) AS percentil_geral
          FROM rank_base rb
        ), avg_nicho AS (
          SELECT AVG(gmv_total) AS media_gmv, COUNT(*) AS amostra
          FROM base_90_dias
          WHERE nicho IS NOT DISTINCT FROM $3
        ), avg_geral AS (
          SELECT AVG(gmv_total) AS media_gmv, COUNT(*) AS amostra
          FROM base_90_dias
        ), meu_rank AS (
          SELECT percentil_nicho, percentil_geral
          FROM ranked
          WHERE cliente_id = $2
          LIMIT 1
        )
        SELECT
          cb.nicho,
          cb.meu_gmv,
          an.media_gmv AS media_gmv_nicho,
          an.amostra AS amostra_nicho,
          ag.media_gmv AS media_gmv_geral,
          ag.amostra AS amostra_geral,
          mr.percentil_nicho,
          mr.percentil_geral
        FROM cliente_base cb
        CROSS JOIN avg_nicho an
        CROSS JOIN avg_geral ag
        LEFT JOIN meu_rank mr ON true
      `, [tenant_id, cliente_id, clienteNicho])

      const benchmark = benchmarkQ.rows[0] ?? {}

      const benchmarkNicho = clienteNicho == null
        ? null
        : buildBenchmark({
            niche: clienteNicho,
            meuGmv: benchmark.meu_gmv,
            mediaGmv: benchmark.media_gmv_nicho,
            amostra: benchmark.amostra_nicho,
            percentil: benchmark.percentil_nicho,
            minimumSample: 5,
          })

      const benchmarkGeral = buildBenchmark({
        niche: null,
        meuGmv: benchmark.meu_gmv,
        mediaGmv: benchmark.media_gmv_geral,
        amostra: benchmark.amostra_geral,
        percentil: benchmark.percentil_geral,
          minimumSample: 10,
        })

      const horariosQ = await db.query(`
        WITH periodo AS (
          SELECT
            make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') AS inicio,
            make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${DASHBOARD_TZ}') + INTERVAL '1 month' AS fim
        ), snapshots AS (
          SELECT
            ls.live_id,
            ls.captured_at,
            COALESCE(ls.gmv, 0) AS gmv,
            COALESCE(ls.total_orders, 0) AS total_orders,
            LAG(COALESCE(ls.gmv, 0)) OVER (PARTITION BY ls.live_id ORDER BY ls.captured_at) AS prev_gmv,
            LAG(COALESCE(ls.total_orders, 0)) OVER (PARTITION BY ls.live_id ORDER BY ls.captured_at) AS prev_orders
          FROM lives l
          JOIN live_snapshots ls ON ls.live_id = l.id
          CROSS JOIN periodo p
          WHERE l.tenant_id = $1
            AND l.cliente_id = $2
            AND l.status IN ('encerrada', 'em_andamento')
            AND l.iniciado_em >= p.inicio
            AND l.iniciado_em < p.fim
        ), deltas AS (
          SELECT
            live_id,
            EXTRACT(HOUR FROM timezone('${DASHBOARD_TZ}', captured_at))::int AS hora,
            GREATEST(gmv - COALESCE(prev_gmv, 0), 0) AS gmv_delta,
            GREATEST(total_orders - COALESCE(prev_orders, 0), 0) AS pedidos_delta
          FROM snapshots
        ), snapshot_hours AS (
          SELECT
            hora,
            COUNT(DISTINCT live_id) AS total_lives,
            SUM(gmv_delta) AS gmv_total,
            SUM(pedidos_delta) AS pedidos
          FROM deltas
          GROUP BY hora
          HAVING SUM(gmv_delta) > 0
        ), fallback_hours AS (
          SELECT
            EXTRACT(HOUR FROM timezone('${DASHBOARD_TZ}', l.iniciado_em))::int AS hora,
            COUNT(l.id) AS total_lives,
            COALESCE(SUM(l.fat_gerado), 0) AS gmv_total,
            COALESCE(SUM(prod.itens), 0) AS pedidos
          FROM lives l
          CROSS JOIN periodo p
          LEFT JOIN LATERAL (
            SELECT SUM(lp.quantidade) AS itens
            FROM live_products lp
            WHERE lp.live_id = l.id
          ) prod ON true
          WHERE l.tenant_id = $1
            AND l.cliente_id = $2
            AND l.status IN ('encerrada', 'em_andamento')
            AND l.iniciado_em >= p.inicio
            AND l.iniciado_em < p.fim
            AND NOT EXISTS (SELECT 1 FROM snapshot_hours)
          GROUP BY hora
        )
        SELECT hora, total_lives, gmv_total, pedidos
        FROM snapshot_hours
        UNION ALL
        SELECT hora, total_lives, gmv_total, pedidos
        FROM fallback_hours
        ORDER BY gmv_total DESC, hora ASC
        LIMIT 6
      `, [tenant_id, cliente_id, periodo.ano, periodo.mes])

      const melhoresHorariosVenda = horariosQ.rows.map((r) => ({
        hora: toInt(r.hora),
        label: `${toInt(r.hora).toString().padStart(2, '0')}h`,
        total_lives: toInt(r.total_lives),
        gmv_total: round2(r.gmv_total),
        pedidos: toInt(r.pedidos),
      }))

      const seriesQ = await db.query(`
        WITH meses AS (
          SELECT generate_series(1, 12) AS mes
        )
        SELECT
          m.mes,
          COUNT(l.id) AS total_lives,
          COALESCE(SUM(l.fat_gerado), 0) AS gmv_total,
          COALESCE(SUM(prod.itens), 0) AS itens_vendidos,
          COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, NOW()) - l.iniciado_em)) / 3600, 0)), 0) AS horas_live
        FROM meses m
        LEFT JOIN lives l
          ON l.tenant_id = $1
         AND l.cliente_id = $2
         AND l.status IN ('encerrada', 'em_andamento')
         AND EXTRACT(YEAR FROM timezone('${DASHBOARD_TZ}', l.iniciado_em))::int = $3
         AND EXTRACT(MONTH FROM timezone('${DASHBOARD_TZ}', l.iniciado_em))::int = m.mes
        LEFT JOIN LATERAL (
          SELECT SUM(lp.quantidade) AS itens
          FROM live_products lp
          WHERE lp.live_id = l.id
        ) prod ON true
        GROUP BY m.mes
        ORDER BY m.mes
      `, [tenant_id, cliente_id, periodo.ano])

      const seriesMensais = seriesQ.rows.map((r) => {
        const horasLive = round2(r.horas_live)
        const valorInvestido = round2(horasLive * custoHora)
        const gmvTotal = round2(r.gmv_total)

        return {
          mes: toInt(r.mes),
          ano: periodo.ano,
          total_lives: toInt(r.total_lives),
          gmv_total: gmvTotal,
          itens_vendidos: toInt(r.itens_vendidos),
          horas_live: horasLive,
          valor_investido_lives: valorInvestido,
          roas: valorInvestido > 0 ? round2(gmvTotal / valorInvestido) : 0,
        }
      })

      return {
        periodo,
        faturamento_mes: resumo.gmv_total,
        gmv_mes: resumo.gmv_total,
        crescimento_pct: crescimento,
        volume_vendas:   resumo.itens_vendidos,
        itens_vendidos:  resumo.itens_vendidos,
        lucro_estimado:  round2(livesPayload.lives.reduce((sum, live) => sum + live.comissao, 0)),
        horas_live_mes:  resumo.horas_live,
        horas_live:      resumo.horas_live,
        valor_investido_lives: resumo.valor_investido_lives,
        roas:            resumo.roas,
        viewers:         resumo.viewers,
        comentarios:     resumo.comentarios,
        likes:           resumo.likes,
        shares:          resumo.shares,
        pedidos:         resumo.pedidos,
        total_lives:     resumo.total_lives,
        live_ativa:      liveAtiva,
        mais_vendidos:   maisVendidos,
        ranking_dia:     rankingPeriodo,
        ranking_periodo: rankingPeriodo,
        proxima_reserva: null,
        benchmark_nicho: benchmarkNicho,
        benchmark_geral: benchmarkGeral,
        melhores_horarios_venda: melhoresHorariosVenda,
        series_mensais: seriesMensais,
        lives: livesPayload.lives,
      }

    } catch (e) {
      app.log.error({ err: e }, 'unhandled error')
      throw e
    } finally {
      db.release()
    }
  })

  // GET /v1/cliente/vendas — histórico de lives do cliente por mês
  app.get('/v1/cliente/vendas', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const periodo = parsePeriodo(request.query)
    const db = await app.dbTenant(tenant_id)

    try {
      const clienteAtual = await getClienteVinculado(db, tenant_id, user_id)
      const cliente_id = clienteAtual?.id
      if (!cliente_id) return emptyLivesPayload(periodo)

      const contratoAtivo = await getContratoAtivo(db, tenant_id, cliente_id)
      const custoHora = calcularCustoHora(contratoAtivo)
      return fetchClienteLives(db, tenant_id, cliente_id, periodo, custoHora)
    } finally {
      db.release()
    }
  })

  // GET /v1/cliente/lives — histórico detalhado de lives do cliente por mês
  app.get('/v1/cliente/lives', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const periodo = parsePeriodo(request.query)
    const db = await app.dbTenant(tenant_id)

    try {
      const clienteAtual = await getClienteVinculado(db, tenant_id, user_id)
      const cliente_id = clienteAtual?.id
      if (!cliente_id) return emptyLivesPayload(periodo)

      const contratoAtivo = await getContratoAtivo(db, tenant_id, cliente_id)
      const custoHora = calcularCustoHora(contratoAtivo)
      return fetchClienteLives(db, tenant_id, cliente_id, periodo, custoHora)
    } finally {
      db.release()
    }
  })

  // GET /v1/cliente/produtos — produtos agregados por mês
  app.get('/v1/cliente/produtos', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)

    try {
      const userQ = await db.query(
        `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
        [user_id, tenant_id]
      )
      const email = userQ.rows[0]?.email

      const clienteQ = await db.query(
        `SELECT id FROM clientes WHERE tenant_id = $1 AND email = $2 AND status = 'ativo' LIMIT 1`,
        [tenant_id, email]
      )
      const cliente_id = clienteQ.rows[0]?.id
      if (!cliente_id) return { resumo: { total_produtos: 0, total_qty: 0, total_faturamento: 0 }, produtos: [] }

      const mes = Number(request.query.mes) || (new Date().getMonth() + 1)
      const ano = Number(request.query.ano) || new Date().getFullYear()

      const prodQ = await db.query(`
        SELECT
          lp.produto_nome,
          SUM(lp.quantidade) AS total_qty,
          SUM(lp.valor_total) AS total_faturamento
        FROM live_products lp
        JOIN lives l ON l.id = lp.live_id
        WHERE l.tenant_id = $1
          AND l.cliente_id = $2
          AND EXTRACT(MONTH FROM l.iniciado_em) = $3
          AND EXTRACT(YEAR FROM l.iniciado_em) = $4
          AND l.status IN ('encerrada', 'em_andamento')
        GROUP BY lp.produto_nome
        ORDER BY total_faturamento DESC
      `, [tenant_id, cliente_id, mes, ano])

      const produtos = prodQ.rows.map(p => ({
        produto_nome: p.produto_nome,
        total_qty: Number(p.total_qty),
        total_faturamento: Number(p.total_faturamento),
      }))

      return {
        resumo: {
          total_produtos: produtos.length,
          total_qty: produtos.reduce((s, p) => s + p.total_qty, 0),
          total_faturamento: produtos.reduce((s, p) => s + p.total_faturamento, 0),
        },
        produtos,
      }
    } finally {
      db.release()
    }
  })

  // ──────────────────────────────────────────────────────────────
  // MINHAS CABINES
  // ──────────────────────────────────────────────────────────────

  // GET /v1/cliente/cabines — lista cabines vinculadas ao cliente via contratos ativos
  app.get('/v1/cliente/cabines', {
    preHandler: [app.requirePapel(['cliente_parceiro']), bloquearClienteCabines],
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)

    try {
      const userQ = await db.query(
        `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
        [user_id, tenant_id]
      )
      const email = userQ.rows[0]?.email

      const clienteQ = await db.query(
        `SELECT id FROM clientes WHERE tenant_id = $1 AND email = $2 AND status = 'ativo' LIMIT 1`,
        [tenant_id, email]
      )
      const cliente_id = clienteQ.rows[0]?.id
      if (!cliente_id) return []

      const cabinesQ = await db.query(`
        SELECT
          cab.id,
          cab.numero,
          cab.status,
          cab.live_atual_id,
          cab.contrato_id,
          $2::uuid          AS cliente_id,
          cli.nome          AS cliente_nome,
          u.nome            AS apresentador_nome,
          COALESCE(snap.viewer_count, 0) AS viewer_count,
          COALESCE(snap.gmv, 0)          AS gmv_atual,
          l.iniciado_em
        FROM contratos ct
        JOIN cabines cab ON cab.contrato_id = ct.id
        LEFT JOIN lives l ON l.id = cab.live_atual_id AND l.status = 'em_andamento'
        LEFT JOIN LATERAL (
          SELECT viewer_count, gmv
          FROM live_snapshots
          WHERE live_id = l.id
          ORDER BY captured_at DESC
          LIMIT 1
        ) snap ON true
        LEFT JOIN users u ON u.id = l.apresentador_id
        JOIN clientes cli ON cli.id = ct.cliente_id
        WHERE ct.tenant_id = $1
          AND ct.cliente_id = $2
          AND ct.status = 'ativo'
        ORDER BY cab.numero
      `, [tenant_id, cliente_id])

      return cabinesQ.rows.map(r => ({
        id:               r.id,
        numero:           Number(r.numero),
        status:           r.status,
        live_atual_id:    r.live_atual_id,
        contrato_id:      r.contrato_id,
        cliente_id:       r.cliente_id,
        cliente_nome:     r.cliente_nome,
        apresentador_nome: r.apresentador_nome,
        viewer_count:     Number(r.viewer_count),
        gmv_atual:        Number(r.gmv_atual),
        iniciado_em:      r.iniciado_em,
      }))
    } finally {
      db.release()
    }
  })

  // GET /v1/cliente/cabines/:cabineId — detalhe da cabine + live atual + histórico
  app.get('/v1/cliente/cabines/:cabineId', {
    preHandler: [app.requirePapel(['cliente_parceiro']), bloquearClienteCabines],
  }, async (request, reply) => {
    const { sub: user_id, tenant_id } = request.user
    const { cabineId } = request.params
    const db = await app.dbTenant(tenant_id)

    try {
      const userQ = await db.query(
        `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
        [user_id, tenant_id]
      )
      const email = userQ.rows[0]?.email

      const clienteQ = await db.query(
        `SELECT id FROM clientes WHERE tenant_id = $1 AND email = $2 AND status = 'ativo' LIMIT 1`,
        [tenant_id, email]
      )
      const cliente_id = clienteQ.rows[0]?.id
      if (!cliente_id) return reply.code(403).send({ error: 'Cliente não encontrado' })

      // Valida que a cabine pertence ao cliente via contrato ativo
      const cabineQ = await db.query(`
        SELECT cab.id, cab.numero, cab.status, cab.live_atual_id
        FROM cabines cab
        JOIN contratos ct ON ct.id = cab.contrato_id
        WHERE cab.id = $1
          AND ct.tenant_id = $2
          AND ct.cliente_id = $3
          AND ct.status = 'ativo'
        LIMIT 1
      `, [cabineId, tenant_id, cliente_id])

      if (!cabineQ.rows[0]) {
        return reply.code(404).send({ error: 'Cabine não encontrada ou não pertence a este cliente' })
      }
      const cabine = cabineQ.rows[0]

      // Live atual (se houver)
      let liveAtual = null
      if (cabine.live_atual_id) {
        const liveQ = await db.query(`
          SELECT
            l.id AS live_id,
            l.iniciado_em,
            u.nome AS apresentador_nome,
            COALESCE(snap.viewer_count, 0)    AS viewer_count,
            COALESCE(snap.gmv, 0)             AS gmv_atual,
            COALESCE(snap.total_orders, 0)    AS total_orders,
            COALESCE(snap.likes_count, 0)     AS likes_count,
            COALESCE(snap.comments_count, 0)  AS comments_count,
            EXTRACT(EPOCH FROM (NOW() - l.iniciado_em)) / 60 AS duracao_minutos,
            (
              SELECT lp.produto_nome
              FROM live_products lp
              WHERE lp.live_id = l.id
              GROUP BY lp.produto_nome
              ORDER BY SUM(lp.quantidade) DESC
              LIMIT 1
            ) AS top_produto
          FROM lives l
          LEFT JOIN LATERAL (
            SELECT viewer_count, gmv, total_orders, likes_count, comments_count
            FROM live_snapshots
            WHERE live_id = l.id
            ORDER BY captured_at DESC
            LIMIT 1
          ) snap ON true
          LEFT JOIN users u ON u.id = l.apresentador_id
          WHERE l.id = $1 AND l.status = 'em_andamento'
        `, [cabine.live_atual_id])

        if (liveQ.rows[0]) {
          const lr = liveQ.rows[0]
          liveAtual = {
            live_id:          lr.live_id,
            viewer_count:     Number(lr.viewer_count),
            gmv_atual:        Number(lr.gmv_atual),
            total_orders:     Number(lr.total_orders),
            duracao_minutos:  Math.round(Number(lr.duracao_minutos)),
            apresentador_nome: lr.apresentador_nome,
            iniciado_em:      lr.iniciado_em,
            likes_count:      Number(lr.likes_count),
            comments_count:   Number(lr.comments_count),
            top_produto:      lr.top_produto,
          }
        }
      }

      // Histórico das últimas 20 lives desta cabine para este cliente
      const historicoQ = await db.query(`
        SELECT
          l.id,
          l.iniciado_em,
          l.encerrado_em,
          l.status,
          COALESCE(l.fat_gerado, 0)        AS fat_gerado,
          COALESCE(l.comissao_calculada, 0) AS comissao_calculada,
          ROUND(
            EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.iniciado_em) - l.iniciado_em)) / 60
          ) AS duracao_min
        FROM lives l
        WHERE l.tenant_id = $1
          AND l.cabine_id = $2
          AND l.cliente_id = $3
          AND l.status IN ('encerrada', 'em_andamento')
        ORDER BY l.iniciado_em DESC
        LIMIT 20
      `, [tenant_id, cabineId, cliente_id])

      return {
        cabine: {
          id:     cabine.id,
          numero: Number(cabine.numero),
          status: cabine.status,
        },
        live_atual: liveAtual,
        historico_lives: historicoQ.rows.map(r => ({
          id:                 r.id,
          iniciado_em:        r.iniciado_em,
          encerrado_em:       r.encerrado_em,
          status:             r.status,
          fat_gerado:         Number(r.fat_gerado),
          comissao_calculada: Number(r.comissao_calculada),
          duracao_min:        Number(r.duracao_min),
        })),
      }
    } finally {
      db.release()
    }
  })

  // GET /v1/cliente/cabines/:cabineId/solicitacoes — minhas solicitações desta cabine
  app.get('/v1/cliente/cabines/:cabineId/solicitacoes', {
    preHandler: [app.requirePapel(['cliente_parceiro']), bloquearClienteCabines],
  }, async (request, reply) => {
    const { sub: user_id, tenant_id } = request.user
    const { cabineId } = request.params
    const db = await app.dbTenant(tenant_id)

    try {
      const userQ = await db.query(
        `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
        [user_id, tenant_id]
      )
      const email = userQ.rows[0]?.email

      const clienteQ = await db.query(
        `SELECT id FROM clientes WHERE tenant_id = $1 AND email = $2 AND status = 'ativo' LIMIT 1`,
        [tenant_id, email]
      )
      const cliente_id = clienteQ.rows[0]?.id
      if (!cliente_id) return reply.code(403).send({ error: 'Cliente não encontrado' })

      const q = await db.query(`
        SELECT id, data_solicitada, hora_inicio, hora_fim, observacao, status,
               motivo_recusa, criado_em
        FROM live_requests
        WHERE tenant_id = $1
          AND cabine_id = $2
          AND cliente_id = $3
        ORDER BY criado_em DESC
        LIMIT 50
      `, [tenant_id, cabineId, cliente_id])

      return q.rows.map(r => ({
        id:              r.id,
        data_solicitada: r.data_solicitada, // DATE → "YYYY-MM-DD"
        hora_inicio:     r.hora_inicio,     // TIME → "HH:MM:SS"
        hora_fim:        r.hora_fim,
        observacao:      r.observacao,
        status:          r.status,
        motivo_recusa:   r.motivo_recusa,
        criado_em:       r.criado_em,
      }))
    } finally {
      db.release()
    }
  })

  // POST /v1/cliente/cabines/:cabineId/solicitar-live — criar solicitação de live
  app.post('/v1/cliente/cabines/:cabineId/solicitar-live', {
    preHandler: [app.requirePapel(['cliente_parceiro']), bloquearClienteCabines],
  }, async (request, reply) => {
    const { sub: user_id, tenant_id } = request.user
    const { cabineId } = request.params
    const { data_solicitada, hora_inicio, hora_fim, observacao } = request.body ?? {}

    // Validações básicas (sem converter para Date — tudo string)
    if (!data_solicitada || !hora_inicio || !hora_fim) {
      return reply.code(400).send({ error: 'data_solicitada, hora_inicio e hora_fim são obrigatórios' })
    }
    // Formato esperado: "YYYY-MM-DD" e "HH:MM"
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_solicitada)) {
      return reply.code(400).send({ error: 'data_solicitada deve estar no formato YYYY-MM-DD' })
    }
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(hora_inicio) || !/^\d{2}:\d{2}(:\d{2})?$/.test(hora_fim)) {
      return reply.code(400).send({ error: 'hora_inicio e hora_fim devem estar no formato HH:MM' })
    }
    if (hora_fim <= hora_inicio) {
      return reply.code(400).send({ error: 'hora_fim deve ser maior que hora_inicio' })
    }

    const db = await app.dbTenant(tenant_id)
    try {
      const userQ = await db.query(
        `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
        [user_id, tenant_id]
      )
      const email = userQ.rows[0]?.email

      const clienteQ = await db.query(
        `SELECT id FROM clientes WHERE tenant_id = $1 AND email = $2 AND status = 'ativo' LIMIT 1`,
        [tenant_id, email]
      )
      const cliente_id = clienteQ.rows[0]?.id
      if (!cliente_id) return reply.code(403).send({ error: 'Cliente não encontrado' })

      // Valida que a cabine pertence ao cliente via contrato ativo
      const cabineQ = await db.query(`
        SELECT cab.id FROM cabines cab
        JOIN contratos ct ON ct.id = cab.contrato_id
        WHERE cab.id = $1
          AND ct.tenant_id = $2
          AND ct.cliente_id = $3
          AND ct.status = 'ativo'
        LIMIT 1
      `, [cabineId, tenant_id, cliente_id])

      if (!cabineQ.rows[0]) {
        return reply.code(404).send({ error: 'Cabine não encontrada ou não pertence a este cliente' })
      }

      // Valida que a data não é no passado (comparação pura de string ISO date)
      const hoje = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD" UTC
      if (data_solicitada < hoje) {
        return reply.code(400).send({ error: 'data_solicitada não pode ser no passado' })
      }

      const inserted = await db.query(`
        INSERT INTO live_requests
          (tenant_id, cabine_id, cliente_id, solicitante_id,
           data_solicitada, hora_inicio, hora_fim, observacao)
        VALUES ($1, $2, $3, $4, $5::date, $6::time, $7::time, $8)
        RETURNING id, data_solicitada, hora_inicio, hora_fim, observacao, status, criado_em
      `, [tenant_id, cabineId, cliente_id, user_id,
          data_solicitada, hora_inicio, hora_fim, observacao ?? null])

      const r = inserted.rows[0]
      return reply.code(201).send({
        id:              r.id,
        data_solicitada: r.data_solicitada,
        hora_inicio:     r.hora_inicio,
        hora_fim:        r.hora_fim,
        observacao:      r.observacao,
        status:          r.status,
        criado_em:       r.criado_em,
      })
    } finally {
      db.release()
    }
  })

  // GET /v1/cliente/operacional — métricas operacionais com null-real
  app.get('/v1/cliente/operacional', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const periodo = parsePeriodo(request.query)
    const db = await app.dbTenant(tenant_id)

    try {
      // 1. Resolver cliente vinculado ao usuário logado
      const clienteAtual = await getClienteVinculado(db, tenant_id, user_id)
      const cliente_id = clienteAtual?.id
      if (!cliente_id) {
        return buildEmptyOperacional(periodo)
      }

      // 2. Configuração do cliente (meta_gmv_hora, margem_pct)
      const configQ = await db.query(
        `SELECT meta_gmv_hora, margem_pct FROM clientes WHERE id = $1 AND tenant_id = $2`,
        [cliente_id, tenant_id]
      )
      const configRow = configQ.rows[0] ?? {}
      const metaGmvHora = configRow.meta_gmv_hora != null ? Number(configRow.meta_gmv_hora) : 500
      const margemPct   = configRow.margem_pct    != null ? Number(configRow.margem_pct)    : null

      // 3. Contrato ativo → comissao_livelab_pct (= comissao_pct no contrato)
      const contratoAtivo = await getContratoAtivo(db, tenant_id, cliente_id)
      const comissaoLivelabPct = contratoAtivo?.comissao_pct != null
        ? Number(contratoAtivo.comissao_pct)
        : null

      // 4. Agregar métricas do período (apenas lives não-canceladas)
      const m = await fetchMetricasPeriodo(db, tenant_id, cliente_id, periodo)

      const horasLive            = round2(Number(m.horas_live ?? 0))
      const gmv                  = round2(Number(m.gmv        ?? 0))
      const comissaoLivelabTotal = m.comissao_livelab_total    != null ? round2(Number(m.comissao_livelab_total))    : null
      const comissaoApresTotal   = m.comissao_apresentadora_total != null ? round2(Number(m.comissao_apresentadora_total)) : null
      const views                = toInt(m.views ?? 0)
      const clicks               = m.clicks != null ? toInt(m.clicks) : null
      const pedidos              = toInt(m.pedidos ?? 0)
      const primeiroproblema     = m.primeiro_problema ?? null

      // Ratios: null se denominador zero ou null
      const gmvPorHora       = horasLive > 0 ? round2(gmv / horasLive) : null
      const pctMetaHora      = (gmvPorHora != null && metaGmvHora > 0)
        ? round2((gmvPorHora / metaGmvHora) * 100)
        : null
      const comissaoPorHora  = (comissaoLivelabTotal != null && horasLive > 0)
        ? round2(comissaoLivelabTotal / horasLive)
        : null

      // 5. Status operacional do período
      const statusPeriodo = calcularStatusOperacional({
        metaGmvHora,
        margemPct,
        comissaoLivelabPct,
        horas:             horasLive > 0 ? horasLive : null,
        gmv,
        pedidos,
        views,
        clicks,
        problemaReportado: primeiroproblema,
      })

      // 6. Alertas: lives críticas do período (máx 10, mais recentes primeiro)
      const alertasQ = await db.query(`
        WITH periodo AS (
          SELECT
            make_timestamptz($3::int, $4::int, 1, 0, 0, 0, 'America/Sao_Paulo') AS inicio,
            make_timestamptz($3::int, $4::int, 1, 0, 0, 0, 'America/Sao_Paulo') + INTERVAL '1 month' AS fim
        )
        SELECT
          l.id,
          l.status_operacional,
          l.problema,
          l.iniciado_em,
          l.encerrado_em,
          l.fat_gerado,
          EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.iniciado_em) - l.iniciado_em)) / 3600.0
            AS duracao_horas
        FROM lives l
        CROSS JOIN periodo p
        WHERE l.tenant_id = $1
          AND l.cliente_id = $2
          AND l.status != 'cancelada'
          AND l.iniciado_em >= p.inicio
          AND l.iniciado_em  < p.fim
          AND (
            l.status_operacional = 'critico'
            OR (l.status = 'encerrada'
                AND EXTRACT(EPOCH FROM (l.encerrado_em - l.iniciado_em)) / 3600.0 >= 1
                AND COALESCE(l.fat_gerado, 0) = 0)
            OR (l.problema IS NOT NULL)
          )
        ORDER BY l.iniciado_em DESC
        LIMIT 10
      `, [tenant_id, cliente_id, periodo.ano, periodo.mes])

      const alertas = alertasQ.rows.map(r => {
        let tipo = 'aviso'
        let descricao = ''

        if (r.status_operacional === 'critico') {
          tipo = 'critico'
          descricao = r.problema
            ? `Problema reportado: ${r.problema}`
            : `GMV zero em live com ${round2(Number(r.duracao_horas))}h de duração`
        } else if (
          r.status === 'encerrada' &&
          Number(r.duracao_horas) >= 1 &&
          Number(r.fat_gerado ?? 0) === 0
        ) {
          tipo = 'critico'
          descricao = `GMV zero em live com ${round2(Number(r.duracao_horas))}h de duração`
        } else if (r.problema) {
          tipo = 'aviso'
          descricao = `Problema reportado: ${r.problema}`
        }

        return {
          live_id:  r.id,
          tipo,
          descricao,
          data:     r.iniciado_em,
        }
      })

      return {
        periodo,
        config: {
          meta_gmv_hora:       metaGmvHora,
          margem_pct:          margemPct,
          comissao_livelab_pct: comissaoLivelabPct,
        },
        metricas: {
          horas_live:                 horasLive,
          gmv,
          gmv_por_hora:               gmvPorHora,
          pct_meta_hora:              pctMetaHora,
          comissao_livelab_total:     comissaoLivelabTotal,
          comissao_apresentadora_total: comissaoApresTotal,
          comissao_por_hora:          comissaoPorHora,
          funil: {
            views,
            clicks,
            pedidos,
          },
        },
        status:  statusPeriodo,
        alertas,
      }
    } catch (e) {
      app.log.error({ err: e }, 'unhandled error in /v1/cliente/operacional')
      throw e
    } finally {
      db.release()
    }
  })

  // GET /v1/cliente/sessoes — tabela central de sessões de live com status por sessão
  app.get('/v1/cliente/sessoes', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const periodo = parsePeriodo(request.query)

    const rawLimit  = Number.parseInt(request.query.limit,  10)
    const rawOffset = Number.parseInt(request.query.offset, 10)
    const limit  = rawLimit  >= 1 && rawLimit  <= 200 ? rawLimit  : 50
    const offset = rawOffset >= 0 ? rawOffset : 0

    const db = await app.dbTenant(tenant_id)

    try {
      // 1. Resolver cliente vinculado
      const clienteAtual = await getClienteVinculado(db, tenant_id, user_id)
      const cliente_id = clienteAtual?.id
      if (!cliente_id) {
        return { periodo, total: 0, sessoes: [] }
      }

      // 2. Config do cliente (meta_gmv_hora, margem_pct)
      const configQ = await db.query(
        `SELECT meta_gmv_hora, margem_pct FROM clientes WHERE id = $1 AND tenant_id = $2`,
        [cliente_id, tenant_id]
      )
      const configRow = configQ.rows[0] ?? {}
      const metaGmvHora = configRow.meta_gmv_hora != null ? Number(configRow.meta_gmv_hora) : 500
      const margemPct   = configRow.margem_pct    != null ? Number(configRow.margem_pct)    : null

      // 3. Contrato ativo → comissao_livelab_pct
      const contratoAtivo      = await getContratoAtivo(db, tenant_id, cliente_id)
      const comissaoLivelabPct = contratoAtivo?.comissao_pct != null
        ? Number(contratoAtivo.comissao_pct)
        : null

      // 4. Buscar sessões do período (não-canceladas, DESC por iniciado_em)
      const sessoesRows = await fetchSessoesPeriodo(db, tenant_id, cliente_id, periodo, {
        limit,
        offset,
        order: 'DESC',
      })

      const total = sessoesRows.length > 0 ? Number(sessoesRows[0].total_count) : 0

      const sessoes = sessoesRows.map((r) => buildSessao(r, {
        metaGmvHora,
        margemPct,
        comissaoLivelabPct,
      }))

      return { periodo, total, sessoes }
    } catch (e) {
      app.log.error({ err: e }, 'unhandled error in /v1/cliente/sessoes')
      throw e
    } finally {
      db.release()
    }
  })

  // GET /v1/cliente/relatorio.pdf — relatório operacional mensal em PDF
  app.get('/v1/cliente/relatorio.pdf', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request, reply) => {
    const { sub: user_id, tenant_id } = request.user
    const periodo = parsePeriodo(request.query)

    const db = await app.dbTenant(tenant_id)

    try {
      // 1. Resolver cliente vinculado
      const clienteAtual = await getClienteVinculado(db, tenant_id, user_id)
      const cliente_id   = clienteAtual?.id

      if (!cliente_id) {
        return reply.code(404).send({ error: 'Cliente não encontrado para este usuário' })
      }

      // 2. Config do cliente (meta_gmv_hora, margem_pct)
      const configQ = await db.query(
        `SELECT meta_gmv_hora, margem_pct FROM clientes WHERE id = $1 AND tenant_id = $2`,
        [cliente_id, tenant_id],
      )
      const configRow      = configQ.rows[0] ?? {}
      const metaGmvHora    = configRow.meta_gmv_hora != null ? Number(configRow.meta_gmv_hora) : 500
      const margemPct      = configRow.margem_pct    != null ? Number(configRow.margem_pct)    : null

      // 3. Contrato ativo → comissao_livelab_pct
      const contratoAtivo      = await getContratoAtivo(db, tenant_id, cliente_id)
      const comissaoLivelabPct = contratoAtivo?.comissao_pct != null
        ? Number(contratoAtivo.comissao_pct)
        : null

      // 4. Métricas consolidadas — compartilhadas com /v1/cliente/operacional
      const m = await fetchMetricasPeriodo(db, tenant_id, cliente_id, periodo)

      const horasLive            = round2(Number(m.horas_live ?? 0))
      const gmv                  = round2(Number(m.gmv        ?? 0))
      const comissaoLivelabTotal = m.comissao_livelab_total   != null ? round2(Number(m.comissao_livelab_total))   : null
      const comissaoApresTotal   = m.comissao_apresentadora_total != null ? round2(Number(m.comissao_apresentadora_total)) : null
      const views                = toInt(m.views ?? 0)
      const clicks               = m.clicks != null ? toInt(m.clicks) : null
      const pedidos              = toInt(m.pedidos ?? 0)
      const primeiroproblema     = m.primeiro_problema ?? null

      const gmvPorHora    = (horasLive > 0) ? round2(gmv / horasLive)                    : null
      const pctMetaHora   = (gmvPorHora != null && metaGmvHora > 0) ? round2((gmvPorHora / metaGmvHora) * 100) : null
      const comissaoPorHora = (comissaoLivelabTotal != null && horasLive > 0) ? round2(comissaoLivelabTotal / horasLive) : null

      const statusPeriodo = calcularStatusOperacional({
        metaGmvHora,
        margemPct,
        comissaoLivelabPct,
        horas:             horasLive > 0 ? horasLive : null,
        gmv,
        pedidos,
        views,
        clicks,
        problemaReportado: primeiroproblema,
      })

      const operacional = {
        periodo,
        config: {
          meta_gmv_hora:        metaGmvHora,
          margem_pct:           margemPct,
          comissao_livelab_pct: comissaoLivelabPct,
        },
        metricas: {
          horas_live:                 horasLive,
          gmv,
          gmv_por_hora:               gmvPorHora,
          pct_meta_hora:              pctMetaHora,
          comissao_livelab_total:     comissaoLivelabTotal,
          comissao_apresentadora_total: comissaoApresTotal,
          comissao_por_hora:          comissaoPorHora,
          funil: { views, clicks, pedidos },
        },
        status: statusPeriodo,
      }

      // 5. Sessões do período (sem paginação — PDF usa todas, ASC para leitura cronológica)
      const sessoesRows = await fetchSessoesPeriodo(db, tenant_id, cliente_id, periodo, {
        order: 'ASC',
      })

      const sessoesData = sessoesRows.map((r) => buildSessao(r, {
        metaGmvHora,
        margemPct,
        comissaoLivelabPct,
      }))

      // 6. Gerar PDF
      const pdfBuffer = await gerarRelatorioOperacionalPdf({
        cliente: { nome: clienteAtual.nome ?? null },
        periodo,
        operacional,
        sessoes: { sessoes: sessoesData },
      })

      const filename = `relatorio-operacional-${periodo.ano}-${String(periodo.mes).padStart(2, '0')}.pdf`

      return reply
        .code(200)
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        // Relatório financeiro: nunca armazenar em cache de proxy, disco ou CDN.
        .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
        .header('Pragma', 'no-cache')
        .send(pdfBuffer)

    } catch (e) {
      app.log.error({ err: e }, 'unhandled error in /v1/cliente/relatorio.pdf')
      throw e
    } finally {
      db.release()
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers SQL compartilhados entre /operacional, /sessoes e /relatorio.pdf
// ---------------------------------------------------------------------------

/**
 * Busca métricas agregadas do período (GMV, horas, comissões, funil).
 * Mesma query de /v1/cliente/operacional — centralizada aqui para evitar drift.
 *
 * @param {object} db - cliente pg já obtido via app.dbTenant()
 * @param {string} tenantId
 * @param {string} clienteId
 * @param {{ ano: number, mes: number }} periodo
 * @returns {Promise<object>} linha raw do banco (horas_live, gmv, comissao_livelab_total, …)
 */
async function fetchMetricasPeriodo(db, tenantId, clienteId, periodo) {
  const q = await db.query(`
    WITH periodo AS (
      SELECT
        make_timestamptz($3::int, $4::int, 1, 0, 0, 0, 'America/Sao_Paulo') AS inicio,
        make_timestamptz($3::int, $4::int, 1, 0, 0, 0, 'America/Sao_Paulo') + INTERVAL '1 month' AS fim
    )
    SELECT
      -- Horas: apenas lives encerradas (consistência com resto do repo)
      ROUND(
        COALESCE(
          SUM(
            EXTRACT(EPOCH FROM (l.encerrado_em - l.iniciado_em)) / 3600.0
          ) FILTER (WHERE l.status = 'encerrada' AND l.encerrado_em IS NOT NULL),
          0
        )::numeric, 4
      ) AS horas_live,

      -- GMV: COALESCE(0) porque zero medido é zero real
      COALESCE(SUM(l.fat_gerado) FILTER (WHERE l.status IN ('encerrada', 'em_andamento')), 0)
        AS gmv,

      -- Comissão LiveLab acumulada (lives encerradas com valor registrado)
      SUM(l.comissao_calculada) FILTER (WHERE l.status = 'encerrada')
        AS comissao_livelab_total,

      -- Comissão apresentadora acumulada
      SUM(l.comissao_apresentadora_valor) FILTER (WHERE l.status = 'encerrada')
        AS comissao_apresentadora_total,

      -- Funil — views: COALESCE(0) → zero real quando não há snapshots
      COALESCE(
        SUM(
          COALESCE(l.final_peak_viewers, 0)
        ) FILTER (WHERE l.status IN ('encerrada', 'em_andamento')),
        0
      ) AS views,

      -- Clicks: CASE explícito — nenhuma live com clicks = null (não medido)
      CASE
        WHEN COUNT(l.id) FILTER (WHERE l.clicks IS NOT NULL AND l.status IN ('encerrada', 'em_andamento')) = 0
          THEN NULL
        ELSE SUM(l.clicks) FILTER (WHERE l.status IN ('encerrada', 'em_andamento'))
      END AS clicks,

      -- Pedidos
      COALESCE(
        SUM(COALESCE(l.final_orders_count, 0)) FILTER (WHERE l.status IN ('encerrada', 'em_andamento')),
        0
      ) AS pedidos,

      -- Primeiro problema reportado não-nulo (para status do período)
      MIN(l.problema) FILTER (WHERE l.problema IS NOT NULL AND l.status IN ('encerrada', 'em_andamento'))
        AS primeiro_problema

    FROM lives l
    CROSS JOIN periodo p
    WHERE l.tenant_id = $1
      AND l.cliente_id = $2
      AND l.status != 'cancelada'
      AND l.iniciado_em >= p.inicio
      AND l.iniciado_em  < p.fim
  `, [tenantId, clienteId, periodo.ano, periodo.mes])

  return q.rows[0] ?? {}
}

/**
 * Busca sessões (lives não-canceladas) do período.
 *
 * @param {object} db - cliente pg já obtido via app.dbTenant()
 * @param {string} tenantId
 * @param {string} clienteId
 * @param {{ ano: number, mes: number }} periodo
 * @param {{ limit?: number, offset?: number, order?: 'ASC'|'DESC' }} opts
 *   - limit/offset: paginação; omitir (ou passar undefined) para buscar tudo (PDF)
 *   - order: direção do ORDER BY l.iniciado_em (padrão 'DESC')
 * @returns {Promise<object[]>} linhas raw do banco
 */
async function fetchSessoesPeriodo(db, tenantId, clienteId, periodo, opts = {}) {
  const { limit, offset, order = 'DESC' } = opts
  const direction = order === 'ASC' ? 'ASC' : 'DESC'
  const comPaginacao = limit != null && offset != null

  // Paginação: usa $5/$6 como placeholders para preservar parameterized queries.
  // Sem limit/offset (PDF) → sem cláusula LIMIT/OFFSET.
  const paginacaoClause = comPaginacao ? 'LIMIT $5 OFFSET $6' : ''
  const params = comPaginacao
    ? [tenantId, clienteId, periodo.ano, periodo.mes, Number(limit), Number(offset)]
    : [tenantId, clienteId, periodo.ano, periodo.mes]

  const q = await db.query(`
    WITH periodo AS (
      SELECT
        make_timestamptz($3::int, $4::int, 1, 0, 0, 0, 'America/Sao_Paulo') AS inicio,
        make_timestamptz($3::int, $4::int, 1, 0, 0, 0, 'America/Sao_Paulo') + INTERVAL '1 month' AS fim
    )
    SELECT
      l.id,
      l.iniciado_em,
      l.encerrado_em,
      l.status,
      l.fat_gerado,
      l.comissao_calculada,
      l.comissao_apresentadora_valor,
      l.comissao_apresentadora_pct,
      l.clicks,
      l.status_operacional,
      l.problema,
      l.proxima_acao,
      l.final_peak_viewers,
      l.final_orders_count,
      -- Nome da apresentadora: preferir apresentadoras.nome, fallback users.nome
      COALESCE(a.nome, u.nome) AS apresentadora_nome,
      COUNT(*) OVER() AS total_count
    FROM lives l
    CROSS JOIN periodo p
    LEFT JOIN users u ON u.id = l.apresentador_id
    LEFT JOIN apresentadoras a ON a.user_id = l.apresentador_id AND a.tenant_id = l.tenant_id
    WHERE l.tenant_id = $1
      AND l.cliente_id = $2
      AND l.status != 'cancelada'
      AND l.iniciado_em >= p.inicio
      AND l.iniciado_em  < p.fim
    ORDER BY l.iniciado_em ${direction}
    ${paginacaoClause}
  `, params)

  return q.rows
}

// ---------------------------------------------------------------------------
// Helpers privados para /v1/cliente/sessoes
// ---------------------------------------------------------------------------

/**
 * Formata a data da live no fuso America/Sao_Paulo como string YYYY-MM-DD.
 * Garante que uma live de sábado 21h SP não apareça como domingo UTC.
 *
 * @param {Date} date
 * @returns {string}
 */
function toDataSP(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  }).format(date)
}

/**
 * Calcula horas parciais de uma live em andamento (agora - iniciado_em).
 * Para lives encerradas, usa encerrado_em - iniciado_em.
 *
 * @param {Date|string|null} iniciadoEm
 * @param {Date|string|null} encerradoEm
 * @param {string} status
 * @returns {number}
 */
function calcularHoras(iniciadoEm, encerradoEm, status) {
  if (!iniciadoEm) return 0
  const inicio = new Date(iniciadoEm)
  const fim    = encerradoEm ? new Date(encerradoEm) : (status === 'em_andamento' ? new Date() : inicio)
  const diff   = (fim.getTime() - inicio.getTime()) / 3_600_000
  return round2(Math.max(diff, 0))
}

/**
 * Monta o objeto de sessão a partir de uma linha do banco + config do cliente.
 * Aplica null-real: campos não medidos → null; ratios → null se denominador 0/null.
 * Status por sessão: usa coluna lives.status_operacional se preenchida;
 * senão calcula on-the-fly com calcularStatusOperacional.
 *
 * @param {object} r - Linha raw do banco
 * @param {{ metaGmvHora: number, margemPct: number|null, comissaoLivelabPct: number|null }} cfg
 * @returns {object}
 */
function buildSessao(r, { metaGmvHora, margemPct, comissaoLivelabPct }) {
  const iniciadoEm  = r.iniciado_em  ? new Date(r.iniciado_em)  : null
  const encerradoEm = r.encerrado_em ? new Date(r.encerrado_em) : null

  const horas    = calcularHoras(iniciadoEm, encerradoEm, r.status)
  const gmv      = round2(Number(r.fat_gerado ?? 0))
  const pedidos  = r.final_orders_count != null ? toInt(r.final_orders_count) : 0
  const views    = r.final_peak_viewers != null ? toInt(r.final_peak_viewers)  : null
  const clicks   = r.clicks            != null ? toInt(r.clicks)               : null

  // Ratios: null quando denominador 0 ou null
  const gmvPorHora     = horas   > 0              ? round2(gmv    / horas)   : null
  const pedidosPorHora = horas   > 0 && pedidos > 0 ? round2(pedidos / horas) : null

  // Comissão LiveLab
  const comissaoLivelab = r.comissao_calculada != null
    ? round2(Number(r.comissao_calculada))
    : null

  // Comissão apresentadora (null se não há vínculo)
  const comissaoApresentadora    = r.comissao_apresentadora_valor != null
    ? round2(Number(r.comissao_apresentadora_valor))
    : null
  const comissaoApresentadoraPct = r.comissao_apresentadora_pct != null
    ? round2(Number(r.comissao_apresentadora_pct))
    : null

  // fim_de_semana derivado de iniciado_em no fuso SP
  const fimDeSemana = iniciadoEm != null ? isFimDeSemanaSP(iniciadoEm) : false

  // Status por sessão: coluna first, motor como fallback
  let statusSessao, motivosSessao, diagnosticoSessao, proximaAcaoSessao

  if (r.status_operacional != null) {
    // Coluna preenchida — usar como fonte de verdade
    statusSessao     = r.status_operacional
    motivosSessao    = []
    diagnosticoSessao  = null
    proximaAcaoSessao  = null
  } else {
    // Calcular on-the-fly
    const motor = calcularStatusOperacional({
      metaGmvHora,
      margemPct,
      comissaoLivelabPct,
      horas:             horas  > 0 ? horas  : null,
      gmv,
      pedidos,
      views:             views  ?? 0,
      clicks,
      problemaReportado: r.problema ?? null,
    })
    statusSessao      = motor.status
    motivosSessao     = motor.motivos
    diagnosticoSessao = motor.diagnostico
    proximaAcaoSessao = motor.proxima_acao
  }

  // problema / proxima_acao: coluna first, fallback motor
  const problemaFinal      = r.problema      ?? null
  const proximaAcaoFinal   = r.proxima_acao  ?? proximaAcaoSessao ?? null

  return {
    live_id:                  r.id,
    data:                     iniciadoEm ? toDataSP(iniciadoEm) : null,
    inicio:                   r.iniciado_em  ?? null,
    fim:                      r.encerrado_em ?? null,
    apresentadora:            r.apresentadora_nome ?? null,
    horas,
    gmv,
    pedidos,
    views,
    clicks,
    gmv_por_hora:             gmvPorHora,
    pedidos_por_hora:         pedidosPorHora,
    comissao_livelab:         comissaoLivelab,
    comissao_apresentadora:   comissaoApresentadora,
    comissao_apresentadora_pct: comissaoApresentadoraPct,
    fim_de_semana:            fimDeSemana,
    status_operacional:       statusSessao,
    motivos:                  motivosSessao,
    diagnostico:              diagnosticoSessao,
    problema:                 problemaFinal,
    proxima_acao:             proximaAcaoFinal,
  }
}

// ---------------------------------------------------------------------------
// Helpers privados para /v1/cliente/operacional
// ---------------------------------------------------------------------------

function buildEmptyOperacional(periodo) {
  return {
    periodo,
    config: {
      meta_gmv_hora:        500,
      margem_pct:           null,
      comissao_livelab_pct: null,
    },
    metricas: {
      horas_live:                   0,
      gmv:                          0,
      gmv_por_hora:                 null,
      pct_meta_hora:                null,
      comissao_livelab_total:       null,
      comissao_apresentadora_total: null,
      comissao_por_hora:            null,
      funil: { views: 0, clicks: null, pedidos: 0 },
    },
    status: {
      status:        'dados_incompletos',
      motivos:       ['cliente não encontrado'],
      diagnostico:   null,
      proxima_acao:  null,
    },
    alertas: [],
  }
}
