import { performance } from 'node:perf_hooks'
import { getPresenterRanking, monthRangeFromQuery } from '../lib/presenter-ranking.js'
import { getPerformanceRanking } from '../lib/performance-rollups.js'
import { tiktokUsernameSql } from '../lib/tiktok-username.js'
import { liveGmvSql } from '../lib/metric-sql.js'

const HOME_DASHBOARD_CACHE_TTL_MS = Number(process.env.HOME_DASHBOARD_CACHE_TTL_MS ?? 30_000)

// ── Dias úteis (seg–sex, sem feriados — simplificação documentada) ──────────
// Não inclui feriados nacionais/estaduais. A precisão é suficiente para
// projeção de ritmo intradia; se precisar de feriados, injetar calendário.
function _isWeekday(date) {
  const d = date.getDay() // 0=dom, 6=sab
  return d !== 0 && d !== 6
}

/**
 * Conta dias úteis (seg–sex) no mês YYYY-MM.
 * Junho/2026 = 22 dias úteis, validado no teste.
 */
function countWeekdaysInMonth(yyyy, mm) {
  const total = new Date(yyyy, mm, 0).getDate() // dias no mês
  let count = 0
  for (let d = 1; d <= total; d++) {
    if (_isWeekday(new Date(yyyy, mm - 1, d))) count++
  }
  return count
}

/**
 * Conta quantos dias úteis transcorreram até (e incluindo) `dayOfMonth`.
 * Se o próprio dia for útil, é contado; se for fim de semana, não conta.
 */
function countWeekdaysUpTo(yyyy, mm, dayOfMonth) {
  let count = 0
  for (let d = 1; d <= dayOfMonth; d++) {
    if (_isWeekday(new Date(yyyy, mm - 1, d))) count++
  }
  return count
}
const HOME_DASHBOARD_BROWSER_MAX_AGE_SECONDS = 15
const HOME_DASHBOARD_STALE_SECONDS = 30
const homeDashboardCache = new Map()
const homeDashboardInFlight = new Map()

function homeDashboardCacheEnabled() {
  return Number.isFinite(HOME_DASHBOARD_CACHE_TTL_MS) && HOME_DASHBOARD_CACHE_TTL_MS > 0
}

function getHomeDashboardCache(key, now = Date.now()) {
  const entry = homeDashboardCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    homeDashboardCache.delete(key)
    return null
  }
  return entry.value
}

function setHomeDashboardHeaders(reply, cacheState, startedAt) {
  const totalMs = Math.max(performance.now() - startedAt, 0)
  reply.header('Cache-Control', `private, max-age=${HOME_DASHBOARD_BROWSER_MAX_AGE_SECONDS}, stale-while-revalidate=${HOME_DASHBOARD_STALE_SECONDS}`)
  reply.header('X-Home-Dashboard-Cache', cacheState)
  reply.header('Server-Timing', `cache;desc="${cacheState}", total;dur=${totalMs.toFixed(1)}`)
}

export async function homeRoutes(app) {
  // GET /v1/home/dashboard
  app.get('/v1/home/dashboard', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    // Período opcional via ?mes=YYYY-MM. Sem param → mês efetivo (resolvido no DB).
    const requestedMes = typeof request.query?.mes === 'string' && /^\d{4}-\d{2}$/.test(request.query.mes)
      ? request.query.mes
      : null
    const startedAt = performance.now()
    const cacheKey = `${tenant_id}:${requestedMes ?? 'auto'}`
    const cached = homeDashboardCacheEnabled() ? getHomeDashboardCache(cacheKey) : null
    if (cached) {
      setHomeDashboardHeaders(reply, 'HIT', startedAt)
      return cached
    }

    let payloadPromise = homeDashboardInFlight.get(cacheKey)
    if (!payloadPromise) {
      payloadPromise = app.withTenant(tenant_id, async (db) => {
      try {
      const round2 = (value) => parseFloat(Number(value ?? 0).toFixed(2))
      const growthPct = (current, previous) => {
        const actual = Number(current ?? 0)
        const prior = Number(previous ?? 0)
        if (prior <= 0) return actual > 0 ? 100 : 0
        return parseFloat((((actual - prior) / prior) * 100).toFixed(1))
      }

      // ── Mês efetivo ──────────────────────────────────────────────
      // Espelha o fallback latestPeriodWithData do Analytics: usa o mês
      // corrente se tiver GMV; senão, o último mês com dados. Calculado
      // 1× e propagado por parâmetro ($N::date) — evita MAX() por query.
      let effectiveMonth = requestedMes
      if (!effectiveMonth) {
        const mesEfetivoQ = await db.query(`
          WITH meses AS (
            SELECT date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo') AS m
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              AND COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) > 0
            UNION ALL
            SELECT date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo') AS m
            FROM vendas_atribuidas va
            WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND va.origem = 'video'
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
              AND COALESCE(va.gmv, 0) > 0
          )
          SELECT to_char(
            COALESCE(
              (SELECT m FROM meses
                WHERE m = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
                LIMIT 1),
              (SELECT MAX(m) FROM meses),
              date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
            ), 'YYYY-MM') AS mes
        `)
        effectiveMonth = mesEfetivoQ.rows[0]?.mes ?? new Date().toISOString().slice(0, 7)
      }
      const mesStart = `${effectiveMonth}-01`

      // ── Grupo 1: queries financeiras + cabines ──
      // Defesa em profundidade: tenant_id explícito em cada query
      // (role Postgres atual tem BYPASSRLS — RLS sozinha não filtra).
      const [fixoQ, varQ, custosQ, cabinesQ] = await Promise.all([
        db.query(`SELECT COALESCE(SUM(valor_fixo), 0) AS valor FROM contratos
                  WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
                    AND status = 'ativo'`),
        db.query(`
        SELECT COALESCE(SUM(${liveGmvSql('l')} * (COALESCE(c.comissao_pct, 0) / 100.0)), 0) AS valor
        FROM lives l
        JOIN contratos c ON c.cliente_id = l.cliente_id AND c.status = 'ativo' AND c.tenant_id = l.tenant_id
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
          AND date_trunc('month', l.iniciado_em) = date_trunc('month', $1::date)
      `, [mesStart]),
        db.query(`
        SELECT COALESCE(SUM(valor), 0) AS valor
        FROM custos
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('month', competencia) = date_trunc('month', $1::date)
      `, [mesStart]),
        db.query(`
        SELECT
            c.id,
            c.numero,
            CASE WHEN l.id IS NOT NULL THEN 'ao_vivo'
                 WHEN c.status = 'ao_vivo' THEN 'disponivel'
                 ELSE c.status
            END AS status,
            l.id AS live_atual_id,
            l.iniciado_em,
            cl.nome AS cliente_nome,
            u.nome AS apresentador,
            COALESCE(ls.total_orders, 0) AS total_orders,
            COALESCE(ls.viewer_count, 0) AS viewer_count,
            COALESCE(ls.gmv, 0) AS gmv_atual,
            ${tiktokUsernameSql({ marca: 'm_live', cliente: 'cl_tiktok', contrato: 'ct' })} AS tiktok_username,
            COALESCE(ct.horas_contratadas, 0) AS horas_contratadas,
            COALESCE(enc.horas_realizadas_hoje, 0) AS horas_realizadas_hoje,
            (SELECT JSON_AGG(u2.nome ORDER BY la.criado_em)
             FROM live_apresentadores la
             JOIN users u2 ON u2.id = la.apresentador_id
             WHERE la.live_id = l.id) AS apresentadores_extra
        FROM cabines c
        LEFT JOIN LATERAL (
            SELECT l.*
            FROM lives l
            WHERE l.cabine_id = c.id
              AND l.tenant_id = c.tenant_id
              AND l.status = 'em_andamento'
            ORDER BY (l.id = c.live_atual_id) DESC, l.iniciado_em DESC
            LIMIT 1
        ) l ON true
        LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = c.tenant_id
        LEFT JOIN marcas m_live ON m_live.id = l.marca_id AND m_live.tenant_id = c.tenant_id
        LEFT JOIN users u ON u.id = l.apresentador_id
        LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = c.tenant_id
        LEFT JOIN clientes cl_tiktok ON cl_tiktok.id = COALESCE(m_live.cliente_id, l.cliente_id, ct.cliente_id) AND cl_tiktok.tenant_id = c.tenant_id
        LEFT JOIN LATERAL (
            SELECT viewer_count, total_orders, gmv
            FROM live_snapshots
            WHERE live_id = l.id
              AND tenant_id = c.tenant_id
            ORDER BY captured_at DESC LIMIT 1
        ) ls ON true
        LEFT JOIN LATERAL (
	            SELECT COALESCE(SUM(LEAST(EXTRACT(EPOCH FROM (COALESCE(encerrado_em, previsto_fim) - iniciado_em)) / 3600.0, 24.0)), 0) AS horas_realizadas_hoje
	            FROM lives
	            WHERE cabine_id = c.id
	              AND tenant_id = c.tenant_id
	              AND status = 'encerrada'
	              AND COALESCE(encerrado_em, previsto_fim) IS NOT NULL
	              AND COALESCE(encerrado_em, previsto_fim) > iniciado_em
	              AND date_trunc('day', iniciado_em) = date_trunc('day', NOW())
        ) enc ON true
        WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND c.ativo IS NOT FALSE
        ORDER BY c.numero
      `),
      ])

      const fatFixo = Number(fixoQ.rows[0].valor)
      const fatComissao = Number(varQ.rows[0].valor)
      const totalCustos = Number(custosQ.rows[0].valor)
      const fatBruto = fatFixo + fatComissao
      const fatLiquido = fatBruto - totalCustos

      const cabinesFormatadas = cabinesQ.rows.map(c => {
        let duracaoMin = 0;
        if (c.status === 'ao_vivo' && c.iniciado_em) {
          const start = new Date(c.iniciado_em);
          const now = new Date();
          duracaoMin = Math.floor((now - start) / 1000 / 60);
        }
        return {
          numero: c.numero,
          id: c.id,
          status: c.status,
          live_atual_id: c.live_atual_id,
          viewer_count: Number(c.viewer_count),
          total_orders: Number(c.total_orders),
          gmv_atual: parseFloat(Number(c.gmv_atual).toFixed(2)),
          cliente_nome: c.cliente_nome,
          apresentador: c.apresentador,
          apresentador_nome: c.apresentador,
          tiktok_username: c.tiktok_username,
          duracao_min: duracaoMin,
          horas_contratadas: parseFloat(Number(c.horas_contratadas).toFixed(2)),
          horas_realizadas_hoje: parseFloat(Number(c.horas_realizadas_hoje).toFixed(2)),
          apresentadores_extra: c.apresentadores_extra || []
        }
      });

      // ── Grupo 2: métricas, pipeline, alertas, ocupação, ranking (independentes) ──
      const [
        clientesQ,
        novosClientesQ,
        livesMesQ,
        gmvOperacionalQ,
        livesHojeQ,
        mediaViewersQ,
        pipelineQ,
        taxaConversaoQ,
        alertasOpsQ,
        ocupacaoQ,
        rankingMarcasQ,
        horasLiveMesQ,
      ] = await Promise.all([
        db.query(`SELECT COUNT(*) AS total FROM clientes
                  WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
                    AND status = 'ativo'`),
        db.query(`
        SELECT COUNT(*) AS total FROM clientes
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('month', criado_em AT TIME ZONE 'America/Sao_Paulo')
              = date_trunc('month', $1::date)
          AND status = 'ativo'
      `, [mesStart]),
        db.query(`
        SELECT COUNT(id) AS lives_mes
        FROM lives
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND status = 'encerrada'
          AND date_trunc('month', iniciado_em AT TIME ZONE 'America/Sao_Paulo')
              = date_trunc('month', $1::date)
      `, [mesStart]),
        db.query(`
        WITH live_metrics AS (
          SELECT
            COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)) FILTER (
              WHERE date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', $1::date)
            ), 0) AS gmv_lives_mes,
            COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)) FILTER (
              WHERE date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', $1::date - INTERVAL '1 month')
            ), 0) AS gmv_lives_mes_anterior,
            COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)) FILTER (
              WHERE date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', $1::date)
            ), 0)::int AS pedidos_lives_mes
          FROM lives l
          WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND l.status = 'encerrada'
        ),
        video_metrics AS (
          SELECT
            COALESCE(SUM(va.gmv) FILTER (
              WHERE va.origem = 'video'
                AND date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', $1::date)
            ), 0) AS gmv_videos_mes,
            COALESCE(SUM(va.gmv) FILTER (
              WHERE va.origem = 'video'
                AND date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', $1::date - INTERVAL '1 month')
            ), 0) AS gmv_videos_mes_anterior,
            COALESCE(SUM(va.pedidos) FILTER (
              WHERE va.origem = 'video'
                AND date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', $1::date)
            ), 0)::int AS pedidos_videos_mes,
            (
              SELECT COUNT(*)::int
              FROM video_registros vr
              WHERE vr.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND date_trunc('month', vr.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', $1::date)
            ) AS videos_mes
          FROM vendas_atribuidas va
          WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
        ),
        home_gmv_operacional AS (
        SELECT
          (lm.gmv_lives_mes + vm.gmv_videos_mes) AS gmv_total_mes,
          (lm.gmv_lives_mes + vm.gmv_videos_mes) AS gmv_mes,
          lm.gmv_lives_mes,
          vm.gmv_videos_mes,
          lm.pedidos_lives_mes,
          vm.pedidos_videos_mes,
          (lm.pedidos_lives_mes + vm.pedidos_videos_mes)::int AS pedidos_total_mes,
          (lm.gmv_lives_mes_anterior + vm.gmv_videos_mes_anterior) AS gmv_mes_anterior,
          lm.gmv_lives_mes_anterior,
          vm.gmv_videos_mes_anterior,
          vm.videos_mes
        FROM live_metrics lm CROSS JOIN video_metrics vm
        )
        SELECT * FROM home_gmv_operacional
      `, [mesStart]),
        db.query(`
        SELECT COUNT(id) AS lives_hoje
        FROM lives
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('day', iniciado_em AT TIME ZONE 'America/Sao_Paulo')
              = date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
      `),
        db.query(`
        SELECT COALESCE(AVG(viewer_count), 0) AS media
        FROM live_snapshots
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('month', captured_at) = date_trunc('month', $1::date)
      `, [mesStart]),
        db.query(`
        SELECT COUNT(*) AS pipeline_aberto, COALESCE(SUM(valor_oportunidade), 0) AS valor_pipeline
        FROM leads
        WHERE franqueadora_id = $1
          AND crm_etapa NOT IN ('ganho','perdido')
          AND status != 'expirado'
      `, [tenant_id]),
        db.query(`
        SELECT
          COUNT(*) FILTER (WHERE crm_etapa = 'ganho') AS ganhos,
          COUNT(*) FILTER (WHERE crm_etapa IN ('ganho','perdido')) AS total_fechados
        FROM leads
        WHERE franqueadora_id = $1
      `, [tenant_id]),
        db.query(`
        SELECT
          (SELECT COUNT(*) FROM clientes
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status = 'inadimplente') AS inadimplentes,
          (SELECT COUNT(*) FROM contratos
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status IN ('rascunho','em_analise')) AS contratos_aguardando_assinatura,
          (SELECT COUNT(*) FROM agenda_eventos ae
           WHERE ae.tenant_id = current_setting('app.tenant_id', true)::uuid
             AND ae.tipo = 'live'
             AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date >= DATE_TRUNC('week', CURRENT_DATE)::date
             AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date < (DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days')::date
             AND ae.status IN ('planejado','confirmado','ao_vivo')) AS agendamentos_semana,
          (SELECT COUNT(*) FROM leads
           WHERE franqueadora_id = $1
             AND crm_etapa NOT IN ('ganho','perdido')
             AND status != 'expirado'
             AND COALESCE(atualizado_em, criado_em) < NOW() - INTERVAL '7 days') AS leads_parados,
          (SELECT COUNT(*) FROM (
            SELECT ae1.id
            FROM agenda_eventos ae1
            JOIN agenda_eventos ae2
              ON ae1.cabine_id = ae2.cabine_id
             AND ae1.id < ae2.id
             AND ae1.data_inicio < ae2.data_fim
             AND ae1.data_fim > ae2.data_inicio
             AND ae1.status IN ('planejado','confirmado','ao_vivo')
             AND ae2.status IN ('planejado','confirmado','ao_vivo')
             AND ae1.tenant_id = current_setting('app.tenant_id', true)::uuid
             AND ae2.tenant_id = current_setting('app.tenant_id', true)::uuid
          ) t) AS conflitos_agenda,
          (SELECT COUNT(*) FROM contratos
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status = 'em_analise') AS contratos_analise,
          (SELECT COUNT(*) FROM boletos
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND (status = 'vencido'
              OR (status = 'pendente' AND vencimento < NOW()))) AS boletos_vencidos,
          (SELECT COUNT(*) FROM leads
           WHERE franqueadora_id = $1
             AND pego_por IS NULL
             AND status = 'disponivel') AS leads_disponiveis,
          (SELECT COUNT(*) FROM cabines
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND ativo IS NOT FALSE
             AND status = 'manutencao') AS cabines_manutencao,
          (SELECT COUNT(*) FROM lives
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status = 'em_andamento'
             AND apresentador_id IS NULL) AS lives_sem_apresentador,
          (SELECT COUNT(*) FROM lives
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status = 'em_andamento'
             AND iniciado_em < NOW() - INTERVAL '4 hours') AS lives_abertas_mais_4h,
          (SELECT COUNT(*)
           FROM lives l
           LEFT JOIN LATERAL (
             SELECT captured_at
             FROM live_snapshots ls
             WHERE ls.live_id = l.id
               AND ls.tenant_id = l.tenant_id
             ORDER BY captured_at DESC
             LIMIT 1
           ) snap ON true
           WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
             AND l.status = 'em_andamento'
             AND (snap.captured_at IS NULL OR snap.captured_at < NOW() - INTERVAL '5 minutes')) AS lives_sem_snapshot_recente
      `, [tenant_id]),
        db.query(`
        SELECT
          COUNT(*) FILTER (WHERE l.status = 'em_andamento') AS ao_vivo,
          COUNT(*) FILTER (WHERE c.ativo IS NOT FALSE) AS operacionais
        FROM cabines c
        LEFT JOIN LATERAL (
          SELECT l.*
          FROM lives l
          WHERE l.cabine_id = c.id
            AND l.tenant_id = c.tenant_id
            AND l.status = 'em_andamento'
          ORDER BY (l.id = c.live_atual_id) DESC, l.iniciado_em DESC
          LIMIT 1
        ) l ON true
        WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
      `),
        getPerformanceRanking(db, {
          tenantId: tenant_id,
          range: monthRangeFromQuery({ mes: effectiveMonth }),
          groupBy: 'marca',
          limit: 10,
        }),
        db.query(`
          SELECT COALESCE(SUM(
            LEAST(EXTRACT(EPOCH FROM (COALESCE(encerrado_em, previsto_fim) - iniciado_em)) / 3600.0, 24.0)
          ), 0) AS horas_live_mes
          FROM lives
          WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
            AND status = 'encerrada'
            AND COALESCE(encerrado_em, previsto_fim) IS NOT NULL
            AND COALESCE(encerrado_em, previsto_fim) > iniciado_em
            AND date_trunc('month', iniciado_em AT TIME ZONE 'America/Sao_Paulo')
                = date_trunc('month', $1::date)
        `, [mesStart]),
      ])

      const ganhos = Number(taxaConversaoQ.rows[0].ganhos)
      const totalFechados = Number(taxaConversaoQ.rows[0].total_fechados)
      const taxaConversao = totalFechados > 0
        ? parseFloat(((ganhos / totalFechados) * 100).toFixed(1))
        : 0

      const alertas = alertasOpsQ.rows[0]
      const ocupacao = {
        ao_vivo: Number(ocupacaoQ.rows[0].ao_vivo),
        operacionais: Number(ocupacaoQ.rows[0].operacionais)
      }

      const agendaHojePromise = db.query(`
          SELECT ae.id, ae.tipo, ae.status, ae.data_inicio, ae.data_fim,
                 c.numero AS cabine_numero,
                 c.nome AS cabine_nome,
                 m.nome AS marca_nome,
                 cl.nome AS cliente_nome,
                 ${tiktokUsernameSql({ marca: 'm', cliente: 'cl' })} AS tiktok_username,
                 COALESCE(a_evento.nome, ap_marca.nome) AS apresentadora_nome
          FROM agenda_eventos ae
          JOIN marcas m ON m.id = ae.marca_id
           AND m.tenant_id = ae.tenant_id
          LEFT JOIN clientes cl ON cl.id = m.cliente_id
           AND cl.tenant_id = ae.tenant_id
          LEFT JOIN cabines c ON c.id = ae.cabine_id
           AND c.tenant_id = ae.tenant_id
          LEFT JOIN apresentadoras a_evento ON a_evento.id = ae.apresentadora_id
           AND a_evento.tenant_id = ae.tenant_id
          LEFT JOIN LATERAL (
            SELECT a.nome
            FROM apresentadora_marcas am
            JOIN apresentadoras a ON a.id = am.apresentadora_id
             AND a.tenant_id = am.tenant_id
            WHERE am.tenant_id = ae.tenant_id
              AND am.marca_id = ae.marca_id
              AND am.ativo IS NOT FALSE
            ORDER BY (am.papel = 'principal') DESC, a.nome ASC
            LIMIT 1
          ) ap_marca ON true
          WHERE ae.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY ae.data_inicio ASC
          LIMIT 50
        `).then((agendaQ) => agendaQ.rows.map(r => ({
          id: r.id,
          tipo: r.tipo,
          status: r.status,
          data_inicio: r.data_inicio,
          data_fim: r.data_fim,
          cabine_numero: r.cabine_numero == null ? null : Number(r.cabine_numero),
          cabine_nome: r.cabine_nome,
          marca_nome: r.marca_nome,
          cliente_nome: r.cliente_nome,
          tiktok_username: r.tiktok_username,
          apresentadora_nome: r.apresentadora_nome,
          nome: r.apresentadora_nome
        }))).catch((error) => {
        request.log?.warn?.({ err: error }, 'home/dashboard: agenda_eventos indisponível')
        return []
      })

      const rankingApresentadorasMesPromise = getPresenterRanking(db, {
          tenantId: tenant_id,
          range: monthRangeFromQuery({ mes: effectiveMonth }),
          limit: 10,
        }).then((rows) => rows.map((r) => ({
          ...r,
          gmv: round2(r.gmv),
          gmv_lives: round2(r.gmv_lives),
          gmv_videos: round2(r.gmv_videos),
          fixo: round2(r.fixo),
          comissao_variavel: round2(r.comissao_variavel),
          total_recebido: round2(r.total_recebido),
          gmv_medio_live: Number(r.lives) > 0 ? round2(r.gmv / Number(r.lives)) : 0,
        }))).catch((error) => {
        request.log?.warn?.({ err: error }, 'home/dashboard: ranking de apresentadoras indisponível')
        return []
      })

      const gmvDiarioPromise = db.query(`
          WITH daily AS (
            SELECT
              EXTRACT(DAY FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::int AS dia,
              COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              AND date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')
                  = date_trunc('month', $1::date)
            GROUP BY dia
            UNION ALL
            SELECT
              EXTRACT(DAY FROM va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')::int AS dia,
              COALESCE(SUM(va.gmv), 0) AS gmv
            FROM vendas_atribuidas va
            WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND va.origem = 'video'
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
              AND date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                  = date_trunc('month', $1::date)
            GROUP BY dia
          )
          SELECT
            dia,
            COALESCE(SUM(gmv), 0) AS gmv
          FROM daily
          GROUP BY dia
          ORDER BY dia
        `, [mesStart])
      const metaPromise = db.query(`
          SELECT meta_gmv, m1_teto, m1_pct, m2_teto, m2_pct, m3_teto, m3_pct, m4_pct
          FROM meta_unidade
          WHERE tenant_id = $1
            AND ano_mes = $2
          LIMIT 1
        `, [tenant_id, effectiveMonth])

      // ── Meta diária da unidade (fallback para meta_mes quando não há meta_unidade) ──
      // Lê tenants.meta_diaria_gmv adicionado em migration 024. Usado apenas se
      // meta_unidade não tiver registro para o mês; a meta_mes derivada é
      // meta_diaria_gmv × total de dias úteis do mês (sem feriados).
      const tenantMetaDiariaPromise = db.query(`
          SELECT meta_diaria_gmv
          FROM tenants
          WHERE id = $1
          LIMIT 1
        `, [tenant_id])

      // ── GMV intradia: hoje hora a hora + mesmo dia do mês anterior ──
      // Fonte: mesma que gmvDiario — lives.iniciado_em (status=encerrada,
      // COALESCE ads_gmv/manual_gmv/fat_gerado) UNION vendas_atribuidas.criado_em
      // (origem=video, não reprovada). Uma única query com dois FILTER reduz RTT.
      // "Hoje" e "prev" são calculados em America/Sao_Paulo para consistência
      // com o heatmap de analytics.js (L416).
      // Se o dia do mês atual > dias do mês anterior (ex: 31 em mês que tem 30),
      // usamos o último dia disponível via LEAST($3, date_part('day',...)).
      const gmvIntradayPromise = db.query(`
          WITH hoje_sp AS (
            SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS d
          ),
          prev_day AS (
            SELECT
              LEAST(
                EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int,
                EXTRACT(DAY FROM
                  (date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) - INTERVAL '1 day')
                )::int
              )::int AS dia_prev,
              to_char(
                date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) - INTERVAL '1 month',
                'YYYY-MM'
              ) AS mes_prev
          ),
          src AS (
            -- Lives encerradas: usa iniciado_em como timestamp da venda
            SELECT
              EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::int AS h,
              COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)                    AS gmv,
              (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date                AS dia
            FROM lives l, hoje_sp
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              AND (
                (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date = hoje_sp.d
                OR to_char(l.iniciado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = (SELECT mes_prev FROM prev_day)
                   AND EXTRACT(DAY FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::int
                       = (SELECT dia_prev FROM prev_day)
              )
            UNION ALL
            -- Vendas de vídeo: usa criado_em para capturar a hora exata do registro
            SELECT
              EXTRACT(HOUR FROM va.criado_em AT TIME ZONE 'America/Sao_Paulo')::int AS h,
              va.gmv                                                                  AS gmv,
              (va.criado_em AT TIME ZONE 'America/Sao_Paulo')::date                  AS dia
            FROM vendas_atribuidas va, hoje_sp
            WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND va.origem = 'video'
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
              AND (
                (va.criado_em AT TIME ZONE 'America/Sao_Paulo')::date = hoje_sp.d
                OR to_char(va.criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = (SELECT mes_prev FROM prev_day)
                   AND EXTRACT(DAY FROM va.criado_em AT TIME ZONE 'America/Sao_Paulo')::int
                       = (SELECT dia_prev FROM prev_day)
              )
          ),
          agg AS (
            SELECT
              h,
              dia,
              SUM(gmv) AS gmv_h
            FROM src
            GROUP BY h, dia
          )
          SELECT
            h,
            SUM(gmv_h) FILTER (WHERE dia = (SELECT d FROM hoje_sp))                      AS gmv_hoje,
            SUM(gmv_h) FILTER (WHERE dia <> (SELECT d FROM hoje_sp))                     AS gmv_prev
          FROM agg
          GROUP BY h
          ORDER BY h
        `, [])

      const [agendaHoje, rankingApresentadorasMes, gmvDiarioQ, metaQ, tenantMetaDiariaQ, gmvIntradayQ] = await Promise.all([
        agendaHojePromise,
        rankingApresentadorasMesPromise,
        gmvDiarioPromise,
        metaPromise,
        tenantMetaDiariaPromise,
        gmvIntradayPromise,
      ])

      const proximasLives = agendaHoje
        .filter((r) => r.tipo === 'live' && ['planejado', 'confirmado'].includes(r.status) && new Date(r.data_inicio) > new Date())
        .slice(0, 5)
        .map((r) => ({
          id: r.id,
          data_solicitada: new Date(r.data_inicio).toISOString().slice(0, 10),
          hora_inicio: new Date(r.data_inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }),
          hora_fim: new Date(r.data_fim).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }),
          cabine_numero: r.cabine_numero,
          cliente_nome: r.cliente_nome ?? r.marca_nome,
        }))

      const gmvDiario = (() => {
        const [anoRef, mesRef] = effectiveMonth.split('-').map(Number)
        const diasNoMes = new Date(anoRef, mesRef, 0).getDate()
        const byDay = Object.fromEntries(gmvDiarioQ.rows.map(r => [Number(r.dia), parseFloat(Number(r.gmv).toFixed(2))]))
        return Array.from({ length: diasNoMes }, (_, i) => ({ dia: i + 1, gmv: byDay[i + 1] ?? 0 }))
      })()

      const metaUnidade = metaQ.rows[0] ?? null

      const rankingMarcasRows = Array.isArray(rankingMarcasQ) ? rankingMarcasQ : (rankingMarcasQ.rows ?? [])
      const rankingMarcasMes = rankingMarcasRows.map(r => ({
        marca_id: r.marca_id,
        nome: r.nome,
        logo_url: r.logo_url,
        site: r.site,
        marca_nome: r.marca_nome ?? r.nome,
        gmv: round2(r.gmv_total ?? r.gmv),
        gmv_total: round2(r.gmv_total ?? r.gmv),
        pedidos: Number(r.pedidos ?? 0),
        lives: Number(r.lives ?? r.total_lives ?? 0),
        total_lives: Number(r.total_lives ?? r.lives ?? 0),
        total_videos: Number(r.total_videos ?? 0),
      }))

      const gmvOperacional = gmvOperacionalQ.rows[0] ?? {}
      const gmvMes = round2(gmvOperacional.gmv_total_mes ?? gmvOperacional.gmv_mes)
      const gmvLivesMes = round2(gmvOperacional.gmv_lives_mes)
      const gmvVideosMes = round2(gmvOperacional.gmv_videos_mes)
      const pedidosLivesMes = Number(gmvOperacional.pedidos_lives_mes ?? 0)
      const pedidosVideosMes = Number(gmvOperacional.pedidos_videos_mes ?? 0)
      const pedidosTotalMes = Number(gmvOperacional.pedidos_total_mes ?? (pedidosLivesMes + pedidosVideosMes))
      const videosMes = Number(gmvOperacional.videos_mes ?? 0)
      const livesMes = Number(livesMesQ.rows[0].lives_mes)
      const gmvMesAnterior = round2(gmvOperacional.gmv_mes_anterior)
      const gmvLivesMesAnterior = round2(gmvOperacional.gmv_lives_mes_anterior)

      // ── Campos do painel "GMV — desempenho do mês" ──────────────────────────

      // 1. meta_mes: usa meta_unidade.meta_gmv (registro mensal explícito);
      //    senão deriva tenants.meta_diaria_gmv × dias úteis do mês (sem feriados).
      //    null se nenhuma configuração existir.
      const [anoEf, mesEf] = effectiveMonth.split('-').map(Number)
      const metaMes = (() => {
        if (metaUnidade && Number(metaUnidade.meta_gmv) > 0) {
          return round2(metaUnidade.meta_gmv)
        }
        const metaDiaria = Number(tenantMetaDiariaQ.rows[0]?.meta_diaria_gmv ?? 0)
        if (metaDiaria > 0) {
          // Derivação: meta_diaria_gmv × total de dias úteis (seg–sex) do mês
          return round2(metaDiaria * countWeekdaysInMonth(anoEf, mesEf))
        }
        return null
      })()

      // 2. periodo: dia_util corrente e total de dias úteis do mês.
      //    Referência: data atual em America/Sao_Paulo.
      //    Simplificação documentada: seg–sex, sem feriados nacionais.
      const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
      const diaCalendarioHoje = agora.getDate()
      const mesHoje = agora.getMonth() + 1
      const anoHoje = agora.getFullYear()
      // Só calcula dia_util dentro do mês de referência; fora do mês retorna 0/total
      const isEffectiveMonthCurrent = (anoHoje === anoEf && mesHoje === mesEf)
      const diasUteisMes = countWeekdaysInMonth(anoEf, mesEf)
      const diaUtilAtual = isEffectiveMonthCurrent
        ? countWeekdaysUpTo(anoHoje, mesHoje, diaCalendarioHoje)
        : 0

      // 3. ritmo_projetado: extrapola GMV do mês com base no ritmo até agora.
      //    null se dia_util=0 (evita divisão por zero) ou gmv nulo.
      const ritmoProjetado = (diaUtilAtual > 0 && gmvMes != null)
        ? round2((gmvMes / diaUtilAtual) * diasUteisMes)
        : null

      // 4. gmv_intraday: array fixo de 16 entradas (08–23), uma por hora.
      //    v  = GMV somado naquela hora HOJE (horas futuras → null, não 0).
      //    prev = GMV na mesma hora do mesmo dia do mês anterior (null se sem dados).
      const horaAtualSP = agora.getHours() // 0–23
      const byHora = Object.fromEntries(
        gmvIntradayQ.rows.map(r => [
          Number(r.h),
          {
            v:    r.gmv_hoje != null ? round2(r.gmv_hoje) : null,
            prev: r.gmv_prev != null ? round2(r.gmv_prev) : null,
          },
        ])
      )
      const gmvIntraday = Array.from({ length: 16 }, (_, i) => {
        const h = 8 + i
        const hStr = String(h).padStart(2, '0')
        const entry = byHora[h]
        // Horas futuras de hoje → v=null (front esconde pontos futuros no chart)
        const vValue = h > horaAtualSP ? null : (entry?.v ?? null)
        return { h: hStr, v: vValue, prev: entry?.prev ?? null }
      })

      const liveCabinesAtivas = cabinesFormatadas.filter(c => c.status === 'ao_vivo')
      const gmvAoVivoAgora = round2(liveCabinesAtivas.reduce((acc, c) => acc + Number(c.gmv_atual ?? 0), 0))
      const horasLiveMes = parseFloat(Number(horasLiveMesQ.rows[0]?.horas_live_mes ?? 0).toFixed(1))
      const gmvPorLiveMes = livesMes > 0 ? round2(gmvMes / livesMes) : 0
      const gmvPorHoraMes = horasLiveMes > 0 ? round2(gmvMes / horasLiveMes) : 0
      const gmvPorLivePrev = livesMes > 0 ? round2(gmvMesAnterior / livesMes) : 0
      const ticketMedioMes = pedidosTotalMes > 0 ? round2(gmvMes / pedidosTotalMes) : 0
      const ticketMedioLiveMes = pedidosLivesMes > 0 ? round2(gmvLivesMes / pedidosLivesMes) : 0
      const alertasOperacionais = [
        { tipo: 'conflitos_agenda', label: 'Conflitos de agenda', valor: Number(alertas.conflitos_agenda), prioridade: 'alta' },
        { tipo: 'lives_sem_apresentador', label: 'Lives sem apresentadora definida', valor: Number(alertas.lives_sem_apresentador), prioridade: 'media' },
        { tipo: 'lives_sem_snapshot_recente', label: 'Lives sem snapshot recente', valor: Number(alertas.lives_sem_snapshot_recente), prioridade: 'media' },
        { tipo: 'lives_abertas_mais_4h', label: 'Lives abertas há mais de 4 horas', valor: Number(alertas.lives_abertas_mais_4h), prioridade: 'media' },
        { tipo: 'cabines_manutencao', label: 'Cabines em manutenção', valor: Number(alertas.cabines_manutencao), prioridade: 'baixa' },
      ]

      return {
        // Período de referência (mês efetivo: atual se tem dados, senão último com dados)
        mes_referencia: effectiveMonth,

        // Financeiro
        gmv_total_mes: gmvMes,
        gmv_mes:     gmvMes,
        fat_total:   parseFloat(fatBruto.toFixed(2)),
        fat_bruto:   parseFloat(fatBruto.toFixed(2)),
        fat_liquido: parseFloat(fatLiquido.toFixed(2)),

        // Cabines
        cabines: cabinesFormatadas,

        // Ocupação e próximas lives
        ocupacao_cabines_hoje: ocupacao,
        proximas_lives_dia: proximasLives,

        // Pipeline CRM
        pipeline_aberto:  Number(pipelineQ.rows[0].pipeline_aberto),
        valor_pipeline:   parseFloat(Number(pipelineQ.rows[0].valor_pipeline).toFixed(2)),
        taxa_conversao:   taxaConversao,

        // Resumo do mês
        clientes_ativos:  Number(clientesQ.rows[0].total),
        novos_clientes:   Number(novosClientesQ.rows[0].total),
        lives_mes:        livesMes,
        videos_mes:       videosMes,
        pedidos_mes:      pedidosTotalMes,
        pedidos_total:    pedidosTotalMes,
        pedidos_lives_mes: pedidosLivesMes,
        pedidos_videos_mes: pedidosVideosMes,
        gmv_lives_mes:    gmvLivesMes,
        gmv_videos_mes:   gmvVideosMes,
        horas_live_mes:   horasLiveMes,
        horas_live:       horasLiveMes,
        media_viewers:    Math.round(Number(mediaViewersQ.rows[0].media)),

        // Operação live commerce
        gmv_ao_vivo_agora: gmvAoVivoAgora,
        lives_ativas_agora: liveCabinesAtivas.length,
        lives_hoje: Number(livesHojeQ.rows[0].lives_hoje),
        ticket_medio: ticketMedioMes,
        ticket_medio_mes: ticketMedioMes,
        ticket_medio_live_mes: ticketMedioLiveMes,
        gmv_por_live: gmvPorLiveMes,
        gmv_por_live_mes: gmvPorLiveMes,
        gmv_por_live_prev: gmvPorLivePrev,
        gmv_por_hora: gmvPorHoraMes,
        gmv_por_hora_mes: gmvPorHoraMes,
        gmv_por_hora_prev: 0,
        variacao_gmv_mes_anterior_pct: growthPct(gmvMes, gmvMesAnterior),
        gmv_lives_mes_anterior: gmvLivesMesAnterior,
        gmv_mes_prev: gmvMesAnterior,
        gmv_prev: gmvMesAnterior,
        alertas_operacionais: alertasOperacionais,
        ranking_apresentadoras_mes: rankingApresentadorasMes,
        ranking_apresentadoras_hoje: rankingApresentadorasMes,
        agenda_hoje: agendaHoje,

        // Alertas operacionais
        inadimplentes:                   Number(alertas.inadimplentes),
        contratos_aguardando_assinatura: Number(alertas.contratos_aguardando_assinatura),
        agendamentos_semana:             Number(alertas.agendamentos_semana),
        leads_parados:                   Number(alertas.leads_parados),
        conflitos_agenda:                Number(alertas.conflitos_agenda),
        cabines_manutencao:              Number(alertas.cabines_manutencao),
        lives_sem_apresentador:          Number(alertas.lives_sem_apresentador),
        lives_sem_snapshot_recente:      Number(alertas.lives_sem_snapshot_recente),
        lives_abertas_mais_4h:           Number(alertas.lives_abertas_mais_4h),

        // Alertas legado
        contratos_analise: Number(alertas.contratos_analise),
        boletos_vencidos:  Number(alertas.boletos_vencidos),
        leads_disponiveis: Number(alertas.leads_disponiveis),

        // Ranking comercial mensal
        ranking_marcas_mes: rankingMarcasMes,

        // GMV diário e meta da unidade
        gmv_diario_mes: gmvDiario,
        meta_gmv: metaUnidade ? parseFloat(Number(metaUnidade.meta_gmv).toFixed(2)) : null,
        meta_tiers: metaUnidade ? {
          m1_teto: parseFloat(Number(metaUnidade.m1_teto).toFixed(2)),
          m1_pct: parseFloat(Number(metaUnidade.m1_pct).toFixed(2)),
          m2_teto: parseFloat(Number(metaUnidade.m2_teto).toFixed(2)),
          m2_pct: parseFloat(Number(metaUnidade.m2_pct).toFixed(2)),
          m3_teto: parseFloat(Number(metaUnidade.m3_teto).toFixed(2)),
          m3_pct: parseFloat(Number(metaUnidade.m3_pct).toFixed(2)),
          m4_pct: parseFloat(Number(metaUnidade.m4_pct).toFixed(2)),
        } : null,

        // ── Painel "GMV — desempenho do mês" ──────────────────────────────
        // meta_mes: meta mensal explícita (meta_unidade) ou derivada
        //   (tenants.meta_diaria_gmv × dias úteis do mês). null = não configurada.
        meta_mes: metaMes,
        // periodo: dia útil corrente e total de dias úteis do mês (seg–sex, sem feriados).
        periodo: { dia_util: diaUtilAtual, dias_uteis_total: diasUteisMes },
        // ritmo_projetado: extrapolação linear pelo ritmo até hoje. null se dia_util=0.
        ritmo_projetado: ritmoProjetado,
        // gmv_intraday: 16 entradas (08–23); v=GMV hora hoje, prev=mesmo dia mês anterior.
        //   Horas futuras de hoje: v=null. Sem dados: v/prev=null.
        gmv_intraday: gmvIntraday,
      }
      } catch (error) {
        app.log.error({ err: error }, 'ERRO NA ROTA /v1/home/dashboard')
        throw error
      }
      })
      homeDashboardInFlight.set(cacheKey, payloadPromise)
      payloadPromise.finally(() => homeDashboardInFlight.delete(cacheKey)).catch(() => {})
    }

    const payload = await payloadPromise
    if (homeDashboardCacheEnabled()) {
      homeDashboardCache.set(cacheKey, {
        expiresAt: Date.now() + HOME_DASHBOARD_CACHE_TTL_MS,
        value: payload,
      })
    }
    setHomeDashboardHeaders(reply, 'MISS', startedAt)
    return payload
  })
}
