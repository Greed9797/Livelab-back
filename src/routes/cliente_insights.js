// Portal do cliente final — endpoints de leitura, sempre filtrados pelo cliente
// vinculado ao usuário logado (resolvido via JWT). NUNCA aceita cliente_id do front.
// Regra de visibilidade: cliente só vê lives encerradas e status_publicacao='publicado'
// (exceto bloco de live ao vivo da Home, que pode mostrar live em andamento própria).
const TZ = 'America/Sao_Paulo'

function toNumber(value) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
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
        `SELECT ae.id, ae.data_inicio, ae.data_fim, c.numero AS cabine_numero
         FROM agenda_eventos ae
         LEFT JOIN cabines c ON c.id = ae.cabine_id AND c.tenant_id = ae.tenant_id
         WHERE ae.tenant_id = $1::uuid AND ae.cliente_id = $2::uuid
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
}
