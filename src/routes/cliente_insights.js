// Portal do cliente final — endpoints de leitura, sempre filtrados pelo cliente
// vinculado ao usuário logado (resolvido via JWT). NUNCA aceita cliente_id do front.
// Regra de visibilidade: cliente só vê lives encerradas e status_publicacao='publicado'
// (exceto bloco de live ao vivo da Home, que pode mostrar live em andamento própria).

import { calcularStatusOperacional } from '../services/status_operacional.js'
import { isFimDeSemanaSP } from '../services/comissao.js'
import { buildRelatorioOperacionalPdf } from '../services/reports.js'

const TZ = 'America/Sao_Paulo'

function toNumber(value) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function round2(value) {
  return Number(toNumber(value).toFixed(2))
}

function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
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

async function getClienteVinculado(db, tenantId, userId) {
  const result = await db.query(
    `SELECT id, nome, nicho
       FROM clientes
      WHERE user_id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    [userId, tenantId],
  )
  return result.rows[0] ?? null
}

async function getContratoAtivo(db, tenantId, clienteId) {
  const result = await db.query(
    `SELECT
       c.id, c.valor_fixo, c.comissao_pct, c.horas_contratadas, c.horas_consumidas,
       (COALESCE(c.horas_contratadas,0) - COALESCE(c.horas_consumidas,0)) AS horas_restantes,
       c.status, c.ativado_em, c.assinado_em,
       p.nome AS pacote_nome, p.valor AS pacote_valor, p.horas_incluidas
     FROM contratos c
     LEFT JOIN pacotes p ON p.id = c.pacote_id AND p.tenant_id = c.tenant_id
     WHERE c.tenant_id = $1::uuid AND c.cliente_id = $2::uuid AND c.status = 'ativo'
     ORDER BY c.ativado_em DESC NULLS LAST, c.criado_em DESC
     LIMIT 1`,
    [tenantId, clienteId],
  )
  return result.rows[0] ?? null
}

function contratoDTO(contrato, valorFixo, comissaoPct) {
  if (!contrato) return null
  return {
    id: contrato.id,
    valor_fixo: valorFixo,
    comissao_pct: comissaoPct,
    horas_contratadas: toNumber(contrato.horas_contratadas),
    horas_consumidas: toNumber(contrato.horas_consumidas),
    horas_restantes: toNumber(contrato.horas_restantes),
    pacote_nome: contrato.pacote_nome ?? null,
  }
}

export async function clienteInsightsRoutes(app) {
  const access = [app.authenticate, app.requirePapel(['cliente_parceiro'])]

  // ───────────────── GET /v1/cliente/home ─────────────────
  app.get('/v1/cliente/home', { preHandler: access }, async (request) => {
    const { sub: userId, tenant_id: tenantId } = request.user
    const periodo = parsePeriodo(request.query)

    return app.withTenant(tenantId, async (db) => {
      const cliente = await getClienteVinculado(db, tenantId, userId)
      if (!cliente) {
        return {
          periodo, cliente: null, gmv_mes: 0, gmv_lives_mes: 0, lives_mes: 0,
          horas_live_mes: 0, pedidos: 0, gmv_por_live: 0, gmv_por_hora: 0,
          live_now: [], proximas_lives_dia: [], series_mensais: [], melhores_horarios_venda: [],
          contrato: null,
          financeiro_cliente: { valor_fixo: 0, comissao_pct: 0, comissao_variavel: 0, total_devido: 0 },
        }
      }

      const contrato = await getContratoAtivo(db, tenantId, cliente.id)

      const resumoQ = await db.query(
        `WITH periodo AS (
           SELECT make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${TZ}') AS inicio,
                  make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${TZ}') + INTERVAL '1 month' AS fim
         )
         SELECT
           COALESCE(SUM(l.fat_gerado), 0) AS gmv_mes,
           COUNT(l.id)::int AS lives_mes,
           COALESCE(SUM(l.final_orders_count), 0)::int AS pedidos,
           COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.iniciado_em) - l.iniciado_em)) / 3600, 0)), 0) AS horas_live_mes
         FROM lives l CROSS JOIN periodo p
         WHERE l.tenant_id = $1::uuid AND l.cliente_id = $2::uuid
           AND l.status = 'encerrada' AND l.status_publicacao = 'publicado'
           AND l.iniciado_em >= p.inicio AND l.iniciado_em < p.fim`,
        [tenantId, cliente.id, periodo.ano, periodo.mes],
      )
      const resumo = resumoQ.rows[0] ?? {}

      const liveNowQ = await db.query(
        `SELECT l.id, l.iniciado_em, COALESCE(l.fat_gerado,0) AS gmv,
                COALESCE(l.final_orders_count,0)::int AS pedidos, c.numero AS cabine_numero
         FROM lives l
         LEFT JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
         WHERE l.tenant_id = $1::uuid AND l.cliente_id = $2::uuid
           AND l.status IN ('ao_vivo', 'em_andamento')
         ORDER BY l.iniciado_em DESC LIMIT 3`,
        [tenantId, cliente.id],
      )

      const proximasQ = await db.query(
        // agenda_eventos não tem cliente_id: link via marca_id → marcas.cliente_id
        // (mesmo padrão de lives.js). marca_id presente em todos os eventos de live.
        `SELECT ae.id, ae.data_inicio, ae.data_fim, c.numero AS cabine_numero
         FROM agenda_eventos ae
         JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
         LEFT JOIN cabines c ON c.id = ae.cabine_id AND c.tenant_id = ae.tenant_id
         WHERE ae.tenant_id = $1::uuid AND m.cliente_id = $2::uuid
           AND ae.tipo = 'live' AND ae.data_inicio >= NOW()
           AND (ae.data_inicio AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date
           AND ae.status NOT IN ('cancelado')
         ORDER BY ae.data_inicio LIMIT 5`,
        [tenantId, cliente.id],
      )

      const seriesQ = await db.query(
        `SELECT to_char(date_trunc('month', l.iniciado_em AT TIME ZONE '${TZ}'), 'YYYY-MM') AS mes,
                COALESCE(SUM(l.fat_gerado), 0) AS gmv,
                COUNT(l.id)::int AS lives
         FROM lives l
         WHERE l.tenant_id = $1::uuid AND l.cliente_id = $2::uuid
           AND l.status = 'encerrada' AND l.status_publicacao = 'publicado'
           AND l.iniciado_em >= (date_trunc('month', NOW() AT TIME ZONE '${TZ}') - INTERVAL '5 months')
         GROUP BY 1 ORDER BY 1`,
        [tenantId, cliente.id],
      )

      const gmvMes = round2(resumo.gmv_mes)
      const livesMes = Number(resumo.lives_mes ?? 0)
      const horasLive = round2(resumo.horas_live_mes)
      const pedidos = Number(resumo.pedidos ?? 0)
      const valorFixo = toNumber(contrato?.valor_fixo)
      const comissaoPct = toNumber(contrato?.comissao_pct)
      const comissaoVariavel = round2(gmvMes * (comissaoPct / 100))
      const totalDevido = round2(valorFixo + comissaoVariavel)

      return {
        periodo,
        cliente: { id: cliente.id, nome: cliente.nome, nicho: cliente.nicho },
        gmv_mes: gmvMes,
        gmv_lives_mes: gmvMes,
        lives_mes: livesMes,
        horas_live_mes: horasLive,
        pedidos,
        gmv_por_live: livesMes > 0 ? round2(gmvMes / livesMes) : 0,
        gmv_por_hora: horasLive > 0 ? round2(gmvMes / horasLive) : 0,
        live_now: liveNowQ.rows.map((r) => ({
          id: r.id, iniciado_em: r.iniciado_em, gmv: round2(r.gmv),
          pedidos: Number(r.pedidos ?? 0), cabine_numero: r.cabine_numero ?? null,
        })),
        proximas_lives_dia: proximasQ.rows.map((r) => ({
          id: r.id, data_inicio: r.data_inicio, data_fim: r.data_fim, cabine_numero: r.cabine_numero ?? null,
        })),
        series_mensais: seriesQ.rows.map((r) => ({ mes: r.mes, gmv: round2(r.gmv), lives: Number(r.lives ?? 0) })),
        melhores_horarios_venda: [],
        contrato: contratoDTO(contrato, valorFixo, comissaoPct),
        financeiro_cliente: { valor_fixo: valorFixo, comissao_pct: comissaoPct, comissao_variavel: comissaoVariavel, total_devido: totalDevido },
      }
    })
  })

  // ───────────────── GET /v1/cliente/conteudo/lives ─────────────────
  app.get('/v1/cliente/conteudo/lives', { preHandler: access }, async (request) => {
    const { sub: userId, tenant_id: tenantId } = request.user
    const periodo = parsePeriodo(request.query)
    const emptyResumo = { gmv: 0, lives: 0, pedidos: 0, horas: 0 }

    return app.withTenant(tenantId, async (db) => {
      const cliente = await getClienteVinculado(db, tenantId, userId)
      if (!cliente) return { periodo, resumo: emptyResumo, lives: [] }

      const result = await db.query(
        `WITH periodo AS (
           SELECT make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${TZ}') AS inicio,
                  make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${TZ}') + INTERVAL '1 month' AS fim
         )
         SELECT
           l.id, l.iniciado_em, l.encerrado_em, l.status, l.status_publicacao,
           COALESCE(l.fat_gerado,0) AS gmv, COALESCE(l.final_orders_count,0)::int AS pedidos,
           l.manual_views, l.manual_likes, l.manual_comments, l.manual_shares, l.resumo,
           c.numero AS cabine_numero, u.nome AS apresentador_nome,
           GREATEST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.iniciado_em) - l.iniciado_em)) / 60, 0) AS duracao_min
         FROM lives l CROSS JOIN periodo p
         LEFT JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
         LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
         WHERE l.tenant_id = $1::uuid AND l.cliente_id = $2::uuid
           AND l.status = 'encerrada' AND l.status_publicacao = 'publicado'
           AND l.iniciado_em >= p.inicio AND l.iniciado_em < p.fim
         ORDER BY l.iniciado_em DESC LIMIT 200`,
        [tenantId, cliente.id, periodo.ano, periodo.mes],
      )

      const lives = result.rows.map((r) => ({
        id: r.id, iniciado_em: r.iniciado_em, encerrado_em: r.encerrado_em,
        status: r.status, status_publicacao: r.status_publicacao,
        gmv: round2(r.gmv), pedidos: Number(r.pedidos ?? 0),
        views: toNumber(r.manual_views), likes: toNumber(r.manual_likes),
        comments: toNumber(r.manual_comments), shares: toNumber(r.manual_shares),
        resumo: r.resumo ?? null, cabine_numero: r.cabine_numero ?? null,
        apresentador_nome: r.apresentador_nome ?? null,
        duracao_min: Math.round(toNumber(r.duracao_min)),
      }))

      const resumo = lives.reduce(
        (acc, l) => ({
          gmv: round2(acc.gmv + l.gmv), lives: acc.lives + 1,
          pedidos: acc.pedidos + l.pedidos, horas: round2(acc.horas + l.duracao_min / 60),
        }),
        { ...emptyResumo },
      )

      return { periodo, resumo, lives }
    })
  })

  // ───────────────── GET /v1/cliente/analytics/diario ─────────────────
  app.get('/v1/cliente/analytics/diario', { preHandler: access }, async (request, reply) => {
    const { from, to } = request.query
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
      return reply.code(400).send({ error: 'from/to devem estar em YYYY-MM-DD' })
    }
    const { sub: userId, tenant_id: tenantId } = request.user

    return app.withTenant(tenantId, async (db) => {
      const cliente = await getClienteVinculado(db, tenantId, userId)
      if (!cliente) return []

      const result = await db.query(
        `SELECT
           (l.iniciado_em AT TIME ZONE '${TZ}')::date AS dia,
           COALESCE(SUM(l.fat_gerado), 0) AS gmv_lives,
           COALESCE(SUM(l.final_orders_count), 0)::int AS pedidos,
           COUNT(l.id)::int AS total_lives,
           COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (l.encerrado_em - l.iniciado_em)) / 3600, 0)), 0) AS horas_live
         FROM lives l
         WHERE l.tenant_id = $1::uuid AND l.cliente_id = $2::uuid
           AND l.status = 'encerrada' AND l.status_publicacao = 'publicado'
           AND l.iniciado_em AT TIME ZONE '${TZ}' >= $3::date
           AND l.iniciado_em AT TIME ZONE '${TZ}' < ($4::date + INTERVAL '1 day')
         GROUP BY 1 ORDER BY 1`,
        [tenantId, cliente.id, from, to],
      )

      return result.rows.map((row) => {
        const gmv = round2(row.gmv_lives)
        const horas = toNumber(row.horas_live)
        const lives = Number(row.total_lives ?? 0)
        return {
          dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
          gmv_lives: gmv, gmv_videos: 0, gmv_total: gmv,
          pedidos: Number(row.pedidos ?? 0), total_lives: lives, total_videos: 0,
          horas_live: round2(horas),
          gmv_por_hora: horas > 0 ? round2(gmv / horas) : 0,
          gmv_por_live: lives > 0 ? round2(gmv / lives) : 0,
        }
      })
    })
  })

  // ───────────────── GET /v1/cliente/financeiro ─────────────────
  app.get('/v1/cliente/financeiro', { preHandler: access }, async (request) => {
    const { sub: userId, tenant_id: tenantId } = request.user
    const periodo = parsePeriodo(request.query)

    return app.withTenant(tenantId, async (db) => {
      const cliente = await getClienteVinculado(db, tenantId, userId)
      if (!cliente) {
        return {
          periodo, cliente: null, contrato: null,
          resumo: { gmv_mes: 0, lives_mes: 0, pedidos: 0, mensalidade_fixa: 0, comissao_pct: 0, comissao_variavel: 0, total_devido: 0 },
          boletos: [],
        }
      }

      const contrato = await getContratoAtivo(db, tenantId, cliente.id)

      const gmvQ = await db.query(
        `WITH periodo AS (
           SELECT make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${TZ}') AS inicio,
                  make_timestamptz($3::int, $4::int, 1, 0, 0, 0, '${TZ}') + INTERVAL '1 month' AS fim
         )
         SELECT COALESCE(SUM(l.fat_gerado),0) AS gmv_mes, COUNT(l.id)::int AS lives_mes,
                COALESCE(SUM(l.final_orders_count),0)::int AS pedidos
         FROM lives l CROSS JOIN periodo p
         WHERE l.tenant_id = $1::uuid AND l.cliente_id = $2::uuid
           AND l.status = 'encerrada' AND l.status_publicacao = 'publicado'
           AND l.iniciado_em >= p.inicio AND l.iniciado_em < p.fim`,
        [tenantId, cliente.id, periodo.ano, periodo.mes],
      )

      const gmvMes = round2(gmvQ.rows[0]?.gmv_mes)
      const valorFixo = toNumber(contrato?.valor_fixo)
      const comissaoPct = toNumber(contrato?.comissao_pct)
      const comissaoVariavel = round2(gmvMes * (comissaoPct / 100))
      const totalDevido = round2(valorFixo + comissaoVariavel)

      const boletosQ = await db.query(
        `SELECT id, tipo, competencia, vencimento, valor, status, gateway_url
         FROM boletos
         WHERE tenant_id = $1::uuid AND cliente_id = $2::uuid
         ORDER BY vencimento DESC NULLS LAST LIMIT 12`,
        [tenantId, cliente.id],
      )

      return {
        periodo,
        cliente: { id: cliente.id, nome: cliente.nome },
        contrato: contratoDTO(contrato, valorFixo, comissaoPct),
        resumo: {
          gmv_mes: gmvMes,
          lives_mes: Number(gmvQ.rows[0]?.lives_mes ?? 0),
          pedidos: Number(gmvQ.rows[0]?.pedidos ?? 0),
          mensalidade_fixa: valorFixo,
          comissao_pct: comissaoPct,
          comissao_variavel: comissaoVariavel,
          total_devido: totalDevido,
        },
        boletos: boletosQ.rows.map((b) => ({ ...b, valor: toNumber(b.valor) })),
      }
    })
  })

  // ───────────────── GET /v1/cliente/operacional ─────────────────
  app.get('/v1/cliente/operacional', { preHandler: access }, async (request, reply) => {
    const { sub: userId, tenant_id: tenantId } = request.user
    const periodo = parsePeriodo(request.query)

    const db = await app.dbTenant(tenantId)
    try {
      // 1. Resolve cliente vinculado ao JWT (NUNCA por cliente_id do front)
      const clienteAtual = await getClienteVinculado(db, tenantId, userId)
      if (!clienteAtual) {
        return reply.send(_buildEmptyOperacional(periodo))
      }
      const cliente_id = clienteAtual.id

      // 2. Config do cliente (meta_gmv_hora, margem_pct)
      const configQ = await db.query(
        `SELECT meta_gmv_hora, margem_pct FROM clientes WHERE id = $1 AND tenant_id = $2::uuid`,
        [cliente_id, tenantId],
      )
      const configRow   = configQ.rows[0] ?? {}
      const metaGmvHora = configRow.meta_gmv_hora != null ? Number(configRow.meta_gmv_hora) : 500
      const margemPct   = configRow.margem_pct    != null ? Number(configRow.margem_pct)    : null

      // 3. Contrato ativo → comissao_livelab_pct
      const contratoAtivo      = await getContratoAtivo(db, tenantId, cliente_id)
      const comissaoLivelabPct = contratoAtivo?.comissao_pct != null
        ? Number(contratoAtivo.comissao_pct)
        : null

      // 4. Métricas consolidadas do período (compartilhadas com /sessoes e /relatorio.pdf)
      const m = await _fetchMetricasPeriodo(db, tenantId, cliente_id, periodo)

      const horasLive            = round2(Number(m.horas_live ?? 0))
      const gmv                  = round2(Number(m.gmv        ?? 0))
      const comissaoLivelabTotal = m.comissao_livelab_total   != null ? round2(Number(m.comissao_livelab_total))   : null
      const comissaoApresTotal   = m.comissao_apresentadora_total != null ? round2(Number(m.comissao_apresentadora_total)) : null
      const views                = toInt(m.views ?? 0)
      const clicks               = m.clicks != null ? toInt(m.clicks) : null
      const pedidos              = toInt(m.pedidos ?? 0)
      const primeiroproblema     = m.primeiro_problema ?? null

      const gmvPorHora    = horasLive > 0 ? round2(gmv / horasLive)                                              : null
      const pctMetaHora   = gmvPorHora != null && metaGmvHora > 0 ? round2((gmvPorHora / metaGmvHora) * 100)    : null
      const comissaoPorHora = comissaoLivelabTotal != null && horasLive > 0 ? round2(comissaoLivelabTotal / horasLive) : null

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

      return reply.send({
        periodo,
        config: {
          meta_gmv_hora:        metaGmvHora,
          margem_pct:           margemPct,
          comissao_livelab_pct: comissaoLivelabPct,
        },
        metricas: {
          horas_live:                   horasLive,
          gmv,
          gmv_por_hora:                 gmvPorHora,
          pct_meta_hora:                pctMetaHora,
          comissao_livelab_total:       comissaoLivelabTotal,
          comissao_apresentadora_total: comissaoApresTotal,
          comissao_por_hora:            comissaoPorHora,
          funil: { views, clicks, pedidos },
        },
        status: statusPeriodo,
      })
    } catch (e) {
      app.log.error({ err: e }, 'unhandled error in /v1/cliente/operacional')
      throw e
    } finally {
      db.release()
    }
  })

  // ───────────────── GET /v1/cliente/sessoes ─────────────────
  app.get('/v1/cliente/sessoes', { preHandler: access }, async (request, reply) => {
    const { sub: userId, tenant_id: tenantId } = request.user
    const periodo = parsePeriodo(request.query)

    // Paginação: limit máx 200, default 50
    const rawLimit  = Number.parseInt(request.query.limit,  10)
    const rawOffset = Number.parseInt(request.query.offset, 10)
    const limit  = rawLimit  >= 1 && rawLimit  <= 200 ? rawLimit  : 50
    const offset = rawOffset >= 0                     ? rawOffset : 0
    const comPaginacao = !Number.isNaN(rawLimit)

    const db = await app.dbTenant(tenantId)
    try {
      const clienteAtual = await getClienteVinculado(db, tenantId, userId)
      if (!clienteAtual) {
        return reply.send({ periodo, total: 0, sessoes: [] })
      }
      const cliente_id = clienteAtual.id

      // Config para calcular status on-the-fly
      const configQ = await db.query(
        `SELECT meta_gmv_hora, margem_pct FROM clientes WHERE id = $1 AND tenant_id = $2::uuid`,
        [cliente_id, tenantId],
      )
      const configRow   = configQ.rows[0] ?? {}
      const metaGmvHora = configRow.meta_gmv_hora != null ? Number(configRow.meta_gmv_hora) : 500
      const margemPct   = configRow.margem_pct    != null ? Number(configRow.margem_pct)    : null

      const contratoAtivo      = await getContratoAtivo(db, tenantId, cliente_id)
      const comissaoLivelabPct = contratoAtivo?.comissao_pct != null
        ? Number(contratoAtivo.comissao_pct)
        : null

      const rows = await _fetchSessoesPeriodo(db, tenantId, cliente_id, periodo, {
        limit:  comPaginacao ? limit  : undefined,
        offset: comPaginacao ? offset : undefined,
        order: 'DESC',
      })

      const total = rows.length > 0 ? toInt(rows[0].total_count ?? rows.length) : 0
      const sessoes = rows.map((r) => _buildSessao(r, { metaGmvHora, margemPct, comissaoLivelabPct }))

      return reply.send({ periodo, total, sessoes })
    } catch (e) {
      app.log.error({ err: e }, 'unhandled error in /v1/cliente/sessoes')
      throw e
    } finally {
      db.release()
    }
  })

  // ───────────────── GET /v1/cliente/relatorio.pdf ─────────────────
  app.get('/v1/cliente/relatorio.pdf', { preHandler: access }, async (request, reply) => {
    const { sub: userId, tenant_id: tenantId } = request.user
    const periodo = parsePeriodo(request.query)

    const db = await app.dbTenant(tenantId)
    try {
      const clienteAtual = await getClienteVinculado(db, tenantId, userId)
      if (!clienteAtual) {
        return reply.code(404).send({ error: 'Cliente não encontrado para este usuário' })
      }
      const cliente_id = clienteAtual.id

      const configQ = await db.query(
        `SELECT meta_gmv_hora, margem_pct FROM clientes WHERE id = $1 AND tenant_id = $2::uuid`,
        [cliente_id, tenantId],
      )
      const configRow   = configQ.rows[0] ?? {}
      const metaGmvHora = configRow.meta_gmv_hora != null ? Number(configRow.meta_gmv_hora) : 500
      const margemPct   = configRow.margem_pct    != null ? Number(configRow.margem_pct)    : null

      const contratoAtivo      = await getContratoAtivo(db, tenantId, cliente_id)
      const comissaoLivelabPct = contratoAtivo?.comissao_pct != null
        ? Number(contratoAtivo.comissao_pct)
        : null

      // Métricas
      const m = await _fetchMetricasPeriodo(db, tenantId, cliente_id, periodo)

      const horasLive            = round2(Number(m.horas_live ?? 0))
      const gmv                  = round2(Number(m.gmv        ?? 0))
      const comissaoLivelabTotal = m.comissao_livelab_total   != null ? round2(Number(m.comissao_livelab_total))   : null
      const comissaoApresTotal   = m.comissao_apresentadora_total != null ? round2(Number(m.comissao_apresentadora_total)) : null
      const views                = toInt(m.views ?? 0)
      const clicks               = m.clicks != null ? toInt(m.clicks) : null
      const pedidos              = toInt(m.pedidos ?? 0)
      const primeiroproblema     = m.primeiro_problema ?? null

      const gmvPorHora    = horasLive > 0 ? round2(gmv / horasLive)                                              : null
      const pctMetaHora   = gmvPorHora != null && metaGmvHora > 0 ? round2((gmvPorHora / metaGmvHora) * 100)    : null
      const comissaoPorHora = comissaoLivelabTotal != null && horasLive > 0 ? round2(comissaoLivelabTotal / horasLive) : null

      const statusPeriodo = calcularStatusOperacional({
        metaGmvHora, margemPct, comissaoLivelabPct,
        horas: horasLive > 0 ? horasLive : null,
        gmv, pedidos, views, clicks,
        problemaReportado: primeiroproblema,
      })

      const operacional = {
        periodo,
        config: { meta_gmv_hora: metaGmvHora, margem_pct: margemPct, comissao_livelab_pct: comissaoLivelabPct },
        metricas: {
          horas_live: horasLive, gmv, gmv_por_hora: gmvPorHora, pct_meta_hora: pctMetaHora,
          comissao_livelab_total: comissaoLivelabTotal, comissao_apresentadora_total: comissaoApresTotal,
          comissao_por_hora: comissaoPorHora, funil: { views, clicks, pedidos },
        },
        status: statusPeriodo,
      }

      // Sessões ordenadas ASC (leitura cronológica no PDF)
      const sessoesRows = await _fetchSessoesPeriodo(db, tenantId, cliente_id, periodo, { order: 'ASC' })
      const sessoesData = sessoesRows.map((r) => _buildSessao(r, { metaGmvHora, margemPct, comissaoLivelabPct }))

      const pdfBuffer = await buildRelatorioOperacionalPdf({
        cliente: { nome: clienteAtual.nome ?? null },
        periodo,
        operacional,
        sessoes: { sessoes: sessoesData },
      })

      const mesStr  = String(periodo.mes).padStart(2, '0')
      const filename = `relatorio-operacional-${periodo.ano}-${mesStr}.pdf`

      return reply
        .header('Content-Type',        'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control',       'no-store, no-cache, must-revalidate, private')
        .header('Pragma',              'no-cache')
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
 * Compartilhada pelos 3 endpoints para evitar drift de SQL.
 *
 * Adaptação codex vs. ref:
 *   - views ← l.live_impressions   (migration 111 — não final_peak_viewers)
 *   - clicks ← l.product_clicks    (migration 111 — não l.clicks genérico)
 */
async function _fetchMetricasPeriodo(db, tenantId, clienteId, periodo) {
  const q = await db.query(`
    WITH periodo AS (
      SELECT
        make_timestamptz($3::int, $4::int, 1, 0, 0, 0, 'America/Sao_Paulo') AS inicio,
        make_timestamptz($3::int, $4::int, 1, 0, 0, 0, 'America/Sao_Paulo') + INTERVAL '1 month' AS fim
    )
    SELECT
      -- Horas: apenas lives encerradas
      ROUND(
        COALESCE(
          SUM(
            EXTRACT(EPOCH FROM (l.encerrado_em - l.iniciado_em)) / 3600.0
          ) FILTER (WHERE l.status = 'encerrada' AND l.encerrado_em IS NOT NULL),
          0
        )::numeric, 4
      ) AS horas_live,

      -- GMV: zero medido é zero real
      COALESCE(SUM(l.fat_gerado) FILTER (WHERE l.status IN ('encerrada', 'em_andamento')), 0)
        AS gmv,

      -- Comissão LiveLab acumulada
      SUM(l.comissao_calculada) FILTER (WHERE l.status = 'encerrada')
        AS comissao_livelab_total,

      -- Comissão apresentadora acumulada
      SUM(l.comissao_apresentadora_valor) FILTER (WHERE l.status = 'encerrada')
        AS comissao_apresentadora_total,

      -- Views: live_impressions (migration 111)
      COALESCE(
        SUM(COALESCE(l.live_impressions, 0)) FILTER (WHERE l.status IN ('encerrada', 'em_andamento')),
        0
      ) AS views,

      -- Clicks: product_clicks (migration 111) — CASE para null-real
      CASE
        WHEN COUNT(l.id) FILTER (
          WHERE l.product_clicks IS NOT NULL AND l.status IN ('encerrada', 'em_andamento')
        ) = 0
          THEN NULL
        ELSE SUM(l.product_clicks) FILTER (WHERE l.status IN ('encerrada', 'em_andamento'))
      END AS clicks,

      -- Pedidos
      COALESCE(
        SUM(COALESCE(l.final_orders_count, 0)) FILTER (WHERE l.status IN ('encerrada', 'em_andamento')),
        0
      ) AS pedidos,

      -- Primeiro problema reportado
      MIN(l.problema) FILTER (
        WHERE l.problema IS NOT NULL AND l.status IN ('encerrada', 'em_andamento')
      ) AS primeiro_problema

    FROM lives l
    CROSS JOIN periodo p
    WHERE l.tenant_id = $1::uuid
      AND l.cliente_id = $2::uuid
      AND l.status != 'cancelada'
      AND l.iniciado_em >= p.inicio
      AND l.iniciado_em  < p.fim
  `, [tenantId, clienteId, periodo.ano, periodo.mes])

  return q.rows[0] ?? {}
}

/**
 * Busca sessões (lives não-canceladas) do período com suporte a paginação.
 *
 * Adaptação codex:
 *   - views ← l.live_impressions  (migration 111)
 *   - clicks ← l.product_clicks   (migration 111)
 *   - JOIN apresentadoras: a.user_id = l.apresentador_id
 *     (codex: lives.apresentador_id = users.id; apresentadoras vinculadas via user_id)
 */
async function _fetchSessoesPeriodo(db, tenantId, clienteId, periodo, opts = {}) {
  const { limit, offset, order = 'DESC' } = opts
  const direction = order === 'ASC' ? 'ASC' : 'DESC'
  const comPaginacao = limit != null && offset != null

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
      l.product_clicks  AS clicks,
      l.live_impressions AS views_raw,
      l.status_operacional,
      l.problema,
      l.proxima_acao,
      l.final_orders_count,
      -- Nome da apresentadora: preferir apresentadoras.nome, fallback users.nome
      COALESCE(a.nome, u.nome) AS apresentadora_nome,
      COUNT(*) OVER() AS total_count
    FROM lives l
    CROSS JOIN periodo p
    LEFT JOIN users u         ON u.id          = l.apresentador_id
    LEFT JOIN apresentadoras a ON a.user_id     = l.apresentador_id AND a.tenant_id = l.tenant_id
    WHERE l.tenant_id = $1::uuid
      AND l.cliente_id = $2::uuid
      AND l.status != 'cancelada'
      AND l.iniciado_em >= p.inicio
      AND l.iniciado_em  < p.fim
    ORDER BY l.iniciado_em ${direction}
    ${paginacaoClause}
  `, params)

  return q.rows
}

// ---------------------------------------------------------------------------
// Helpers privados de apresentação de sessão
// ---------------------------------------------------------------------------

/**
 * Formata a data da live no fuso America/Sao_Paulo como string YYYY-MM-DD.
 * Garante que live de sábado 21h SP não apareça como domingo UTC.
 */
function _toDataSP(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

/**
 * Calcula horas de uma live.
 * Lives em andamento: usa (agora - iniciado_em) como horas parciais.
 */
function _calcularHoras(iniciadoEm, encerradoEm, status) {
  if (!iniciadoEm) return 0
  const inicio = new Date(iniciadoEm)
  const fim = encerradoEm
    ? new Date(encerradoEm)
    : (status === 'em_andamento' ? new Date() : inicio)
  const diff = (fim.getTime() - inicio.getTime()) / 3_600_000
  return round2(Math.max(diff, 0))
}

/**
 * Monta o objeto de sessão a partir de uma linha do banco + config do cliente.
 * Status: usa lives.status_operacional se preenchida; calcula on-the-fly como fallback.
 */
function _buildSessao(r, { metaGmvHora, margemPct, comissaoLivelabPct }) {
  const iniciadoEm  = r.iniciado_em  ? new Date(r.iniciado_em)  : null
  const encerradoEm = r.encerrado_em ? new Date(r.encerrado_em) : null

  const horas   = _calcularHoras(iniciadoEm, encerradoEm, r.status)
  const gmv     = round2(Number(r.fat_gerado ?? 0))
  const pedidos = r.final_orders_count != null ? toInt(r.final_orders_count) : 0
  const views   = r.views_raw  != null ? toInt(r.views_raw)  : null
  const clicks  = r.clicks     != null ? toInt(r.clicks)     : null

  const gmvPorHora     = horas   > 0               ? round2(gmv     / horas)   : null
  const pedidosPorHora = horas   > 0 && pedidos > 0 ? round2(pedidos / horas)   : null

  const comissaoLivelab = r.comissao_calculada != null
    ? round2(Number(r.comissao_calculada))
    : null

  const comissaoApresentadora    = r.comissao_apresentadora_valor != null
    ? round2(Number(r.comissao_apresentadora_valor))
    : null
  const comissaoApresentadoraPct = r.comissao_apresentadora_pct != null
    ? round2(Number(r.comissao_apresentadora_pct))
    : null

  const fimDeSemana = iniciadoEm != null ? isFimDeSemanaSP(iniciadoEm) : false

  // Status: coluna first, motor on-the-fly como fallback
  let statusSessao, motivosSessao, diagnosticoSessao, proximaAcaoSessao

  if (r.status_operacional != null) {
    statusSessao      = r.status_operacional
    motivosSessao     = []
    diagnosticoSessao = null
    proximaAcaoSessao = null
  } else {
    const motor = calcularStatusOperacional({
      metaGmvHora, margemPct, comissaoLivelabPct,
      horas:   horas   > 0 ? horas   : null,
      gmv,
      pedidos,
      views,
      clicks,
      problemaReportado: r.problema ?? null,
    })
    statusSessao      = motor.status
    motivosSessao     = motor.motivos
    diagnosticoSessao = motor.diagnostico
    proximaAcaoSessao = motor.proxima_acao
  }

  const problemaFinal    = r.problema      ?? null
  const proximaAcaoFinal = r.proxima_acao  ?? proximaAcaoSessao ?? null

  return {
    live_id:                    r.id,
    data:                       iniciadoEm ? _toDataSP(iniciadoEm) : null,
    inicio:                     r.iniciado_em  ?? null,
    fim:                        r.encerrado_em ?? null,
    apresentadora:              r.apresentadora_nome ?? null,
    horas,
    gmv,
    pedidos,
    views,
    clicks,
    gmv_por_hora:               gmvPorHora,
    pedidos_por_hora:           pedidosPorHora,
    comissao_livelab:           comissaoLivelab,
    comissao_apresentadora:     comissaoApresentadora,
    comissao_apresentadora_pct: comissaoApresentadoraPct,
    fim_de_semana:              fimDeSemana,
    status_operacional:         statusSessao,
    motivos:                    motivosSessao,
    diagnostico:                diagnosticoSessao,
    problema:                   problemaFinal,
    proxima_acao:               proximaAcaoFinal,
  }
}

/**
 * Payload de operacional vazio para quando o cliente não é encontrado.
 */
function _buildEmptyOperacional(periodo) {
  return {
    periodo,
    config: { meta_gmv_hora: 500, margem_pct: null, comissao_livelab_pct: null },
    metricas: {
      horas_live: 0, gmv: 0, gmv_por_hora: null, pct_meta_hora: null,
      comissao_livelab_total: null, comissao_apresentadora_total: null, comissao_por_hora: null,
      funil: { views: 0, clicks: null, pedidos: 0 },
    },
    status: {
      status:       'dados_incompletos',
      motivos:      ['cliente não encontrado'],
      diagnostico:  null,
      proxima_acao: null,
    },
  }
}
