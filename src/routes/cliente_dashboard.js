import { getClienteId } from '../lib/cliente_resolver.js'

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
	      gmv_por_live: 0,
	      gmv_por_hora: 0,
	      ticket_medio_live: 0,
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
	    gmv_por_live: 0,
	    gmv_por_hora: 0,
	    ticket_medio_live: 0,
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

// Resolve cliente_parceiro do user logado SEMPRE via FK clientes.user_id.
// Nunca usar fallback por email — dois clientes mesmo email/tenant => vazamento.
async function getClienteVinculado(db, tenantId, userId) {
  const r = await db.query(
    `SELECT id, nicho, nome FROM clientes WHERE user_id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    [userId, tenantId],
  )
  return r.rows[0] ?? null
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
      COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS total_faturamento,
      COALESCE(l.fat_gerado, 0) AS fat_gerado,
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
	      fat_gerado: round2(r.fat_gerado),
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
  resumo.gmv_por_live = resumo.total_lives > 0 ? round2(resumo.gmv_total / resumo.total_lives) : 0
  resumo.gmv_por_hora = resumo.horas_live > 0 ? round2(resumo.gmv_total / resumo.horas_live) : 0
  resumo.ticket_medio_live = resumo.gmv_por_live

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
    return app.withTenant(tenant_id, async (db) => {
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
                            THEN COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) END), 0) AS mes_atual,
          COALESCE(SUM(CASE WHEN l.iniciado_em >= p.inicio - INTERVAL '1 month' AND l.iniciado_em < p.inicio
                            THEN COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) END), 0) AS mes_anterior
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
            SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)) AS total,
            RANK() OVER (ORDER BY SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)) DESC) AS posicao,
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
            COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_total,
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
	            COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_total,
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

      // Rolling 12 meses até o período selecionado (cross-year). Permite comparar
      // qualquer mês com qualquer histórico, não só dentro do ano corrente.
      const seriesQ = await db.query(`
        WITH base AS (
          SELECT make_date($3::int, $4::int, 1) AS anchor
        ),
        meses AS (
          SELECT
            (anchor - (offset_n || ' months')::interval)::date AS mes_inicio,
            (EXTRACT(YEAR FROM (anchor - (offset_n || ' months')::interval)))::int AS ano,
            (EXTRACT(MONTH FROM (anchor - (offset_n || ' months')::interval)))::int AS mes
          FROM base, generate_series(11, 0, -1) AS offset_n
        )
        SELECT
          m.ano,
          m.mes,
          COUNT(l.id) AS total_lives,
          COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_total,
          COALESCE(SUM(prod.itens), 0) AS itens_vendidos,
          COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, NOW()) - l.iniciado_em)) / 3600, 0)), 0) AS horas_live
        FROM meses m
        LEFT JOIN lives l
          ON l.tenant_id = $1
         AND l.cliente_id = $2
         AND l.status IN ('encerrada', 'em_andamento')
         AND EXTRACT(YEAR FROM timezone('${DASHBOARD_TZ}', l.iniciado_em))::int = m.ano
         AND EXTRACT(MONTH FROM timezone('${DASHBOARD_TZ}', l.iniciado_em))::int = m.mes
        LEFT JOIN LATERAL (
          SELECT SUM(lp.quantidade) AS itens
          FROM live_products lp
          WHERE lp.live_id = l.id
        ) prod ON true
        GROUP BY m.ano, m.mes, m.mes_inicio
        ORDER BY m.mes_inicio
      `, [tenant_id, cliente_id, periodo.ano, periodo.mes])

      const seriesMensais = seriesQ.rows.map((r) => {
        const horasLive = round2(r.horas_live)
        const valorInvestido = round2(horasLive * custoHora)
        const gmvTotal = round2(r.gmv_total)

        return {
          mes: toInt(r.mes),
          ano: toInt(r.ano),
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
	        gmv_por_live:    resumo.gmv_por_live,
	        gmv_por_hora:    resumo.gmv_por_hora,
	        ticket_medio_live: resumo.ticket_medio_live,
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
      }
    })
  })

  // GET /v1/cliente/vendas — histórico de lives do cliente por mês
  app.get('/v1/cliente/vendas', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const periodo = parsePeriodo(request.query)
    return app.withTenant(tenant_id, async (db) => {
      const clienteAtual = await getClienteVinculado(db, tenant_id, user_id)
      const cliente_id = clienteAtual?.id
      if (!cliente_id) return emptyLivesPayload(periodo)

      const contratoAtivo = await getContratoAtivo(db, tenant_id, cliente_id)
      const custoHora = calcularCustoHora(contratoAtivo)
      return fetchClienteLives(db, tenant_id, cliente_id, periodo, custoHora)
    })
  })

  // GET /v1/cliente/lives — histórico detalhado de lives do cliente por mês
  app.get('/v1/cliente/lives', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    const periodo = parsePeriodo(request.query)
    return app.withTenant(tenant_id, async (db) => {
      const clienteAtual = await getClienteVinculado(db, tenant_id, user_id)
      const cliente_id = clienteAtual?.id
      if (!cliente_id) return emptyLivesPayload(periodo)

      const contratoAtivo = await getContratoAtivo(db, tenant_id, cliente_id)
      const custoHora = calcularCustoHora(contratoAtivo)
      return fetchClienteLives(db, tenant_id, cliente_id, periodo, custoHora)
    })
  })

  // GET /v1/cliente/produtos — produtos agregados por mês
  app.get('/v1/cliente/produtos', {
    preHandler: app.requirePapel(['cliente_parceiro']),
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // Resolve via FK clientes.user_id (NÃO email — evita vazamento entre clientes do mesmo tenant).
      const cliente_id = await getClienteId(db, user_id)
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
    })
  })

  // ──────────────────────────────────────────────────────────────
  // MINHAS CABINES
  // ──────────────────────────────────────────────────────────────

  // GET /v1/cliente/cabines — lista cabines vinculadas ao cliente via contratos ativos
  app.get('/v1/cliente/cabines', {
    preHandler: [app.requirePapel(['cliente_parceiro']), bloquearClienteCabines],
  }, async (request) => {
    const { sub: user_id, tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // Resolve via FK clientes.user_id (NÃO email — evita vazamento entre clientes do mesmo tenant).
      const cliente_id = await getClienteId(db, user_id)
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
    })
  })

  // GET /v1/cliente/cabines/:cabineId — detalhe da cabine + live atual + histórico
  app.get('/v1/cliente/cabines/:cabineId', {
    preHandler: [app.requirePapel(['cliente_parceiro']), bloquearClienteCabines],
  }, async (request, reply) => {
    const { sub: user_id, tenant_id } = request.user
    const { cabineId } = request.params
    return app.withTenant(tenant_id, async (db) => {
      // Resolve via FK clientes.user_id (NÃO email — evita vazamento entre clientes do mesmo tenant).
      const cliente_id = await getClienteId(db, user_id)
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
	          COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv,
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
	          gmv:                Number(r.gmv),
	          comissao_calculada: Number(r.comissao_calculada),
          duracao_min:        Number(r.duracao_min),
        })),
      }
    })
  })

  // GET /v1/cliente/cabines/:cabineId/solicitacoes — minhas solicitações desta cabine
  app.get('/v1/cliente/cabines/:cabineId/solicitacoes', {
    preHandler: [app.requirePapel(['cliente_parceiro']), bloquearClienteCabines],
  }, async (request, reply) => {
    const { sub: user_id, tenant_id } = request.user
    const { cabineId } = request.params
    return app.withTenant(tenant_id, async (db) => {
      // Resolve via FK clientes.user_id (NÃO email — evita vazamento entre clientes do mesmo tenant).
      const cliente_id = await getClienteId(db, user_id)
      if (!cliente_id) return reply.code(403).send({ error: 'Cliente não encontrado' })

      const q = await db.query(`
        SELECT ae.id,
               (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date       AS data_solicitada,
               (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::time::text AS hora_inicio,
               (ae.data_fim    AT TIME ZONE 'America/Sao_Paulo')::time::text AS hora_fim,
               ae.observacoes AS observacao,
               ae.status,
               ae.motivo_cancelamento AS motivo_recusa,
               ae.criado_em
        FROM agenda_eventos ae
        JOIN marcas mar ON mar.id = ae.marca_id AND mar.tenant_id = ae.tenant_id
        WHERE ae.tenant_id = $1
          AND ae.cabine_id = $2
          AND mar.cliente_id = $3
          AND ae.tipo = 'live'
        ORDER BY ae.criado_em DESC
        LIMIT 50
      `, [tenant_id, cabineId, cliente_id])

      return q.rows.map(r => ({
        id:              r.id,
        data_solicitada: r.data_solicitada instanceof Date
          ? r.data_solicitada.toISOString().slice(0, 10)
          : String(r.data_solicitada).slice(0, 10),
        hora_inicio:     String(r.hora_inicio).slice(0, 8),
        hora_fim:        String(r.hora_fim).slice(0, 8),
        observacao:      r.observacao,
        // Retorna status no formato legado para compatibilidade com o frontend
        status:          { planejado: 'pendente', confirmado: 'aprovada', cancelado: 'recusada' }[r.status] ?? r.status,
        motivo_recusa:   r.motivo_recusa,
        criado_em:       r.criado_em,
      }))
    })
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

    return app.withTenant(tenant_id, async (db) => {
      // Resolve via FK clientes.user_id (NÃO email — evita vazamento entre clientes do mesmo tenant).
      const cliente_id = await getClienteId(db, user_id)
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

      // Resolve marca ativa do cliente para criar o evento
      const marcaQ = await db.query(
        `SELECT id FROM marcas WHERE cliente_id = $1 AND tenant_id = $2 AND status = 'ativa' ORDER BY criado_em ASC LIMIT 1`,
        [cliente_id, tenant_id]
      )
      const marcaId = marcaQ.rows[0]?.id ?? null
      if (!marcaId) {
        return reply.code(422).send({ error: 'Sua conta não possui marca ativa. Entre em contato com a unidade.' })
      }

      const inserted = await db.query(`
        INSERT INTO agenda_eventos
          (tenant_id, cabine_id, marca_id, criado_por,
           data_inicio, data_fim, tipo, status, observacoes)
        VALUES ($1, $2, $3, $4,
                ($5::date + $6::time) AT TIME ZONE 'America/Sao_Paulo',
                ($5::date + $7::time) AT TIME ZONE 'America/Sao_Paulo',
                'live', 'planejado', $8)
        RETURNING id,
                  (data_inicio AT TIME ZONE 'America/Sao_Paulo')::date       AS data_solicitada,
                  (data_inicio AT TIME ZONE 'America/Sao_Paulo')::time::text AS hora_inicio,
                  (data_fim    AT TIME ZONE 'America/Sao_Paulo')::time::text AS hora_fim,
                  observacoes AS observacao,
                  status,
                  criado_em
      `, [tenant_id, cabineId, marcaId, user_id,
          data_solicitada, hora_inicio, hora_fim, observacao ?? null])

      const r = inserted.rows[0]
      return reply.code(201).send({
        id:              r.id,
        data_solicitada: r.data_solicitada instanceof Date
          ? r.data_solicitada.toISOString().slice(0, 10)
          : String(r.data_solicitada).slice(0, 10),
        hora_inicio:     String(r.hora_inicio).slice(0, 8),
        hora_fim:        String(r.hora_fim).slice(0, 8),
        observacao:      r.observacao,
        // Retorna 'pendente' para compatibilidade com o frontend
        status:          'pendente',
        criado_em:       r.criado_em,
      })
    })
  })
}
