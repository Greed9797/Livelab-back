import { READ_COMISSOES } from '../config/role_groups.js'
import { getPresenterRanking, limitFromQuery, monthRangeFromQuery } from '../lib/presenter-ranking.js'

const APROVADORES = ['franqueador_master', 'franqueado']

function buildComissaoFilters(query, tenantId) {
  const values = [tenantId]
  const filters = ['va.tenant_id = $1::uuid']
  const add = (sql, value) => {
    values.push(value)
    filters.push(sql.replace('?', `$${values.length}`))
  }

  if (query?.origem && query.origem !== 'all') add('va.origem = ?', query.origem)
  if (query?.marca_id) add('va.marca_id = ?::uuid', query.marca_id)
  if (query?.apresentadora_id) add('va.apresentadora_id = ?::uuid', query.apresentadora_id)
  if (query?.data_inicio) add('va.data >= ?::date', query.data_inicio)
  if (query?.data_fim) add('va.data <= ?::date', query.data_fim)

  return { values, where: filters.join(' AND ') }
}

export async function comissoesRoutes(app) {
  const readAccess  = [app.authenticate, app.requirePapel(READ_COMISSOES)]
  const writeAccess = [app.authenticate, app.requirePapel(APROVADORES)]

  app.get('/v1/comissoes/resumo', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const { values, where } = buildComissaoFilters(request.query, tenant_id)
      const result = await db.query(
        `SELECT
           COALESCE(SUM(va.gmv), 0) AS gmv_total,
           COALESCE(SUM(CASE WHEN va.origem = 'live' THEN va.gmv ELSE 0 END), 0) AS gmv_lives,
           COALESCE(SUM(CASE WHEN va.origem = 'video' THEN va.gmv ELSE 0 END), 0) AS gmv_videos,
           COALESCE(SUM(va.pedidos), 0)::int AS pedidos_total,
           COUNT(*)::int AS registros,
           COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_apresentadoras,
           COALESCE(SUM(va.comissao_franquia), 0) AS comissao_franquia,
           COALESCE(SUM(va.comissao_franqueadora), 0) AS comissao_franqueadora
         FROM vendas_atribuidas va
         WHERE ${where}`,
        values,
      )
      const row = result.rows[0] ?? {}
      return {
        ...row,
        totais: {
          gmv: Number(row.gmv_total ?? 0),
          gmv_lives: Number(row.gmv_lives ?? 0),
          gmv_videos: Number(row.gmv_videos ?? 0),
          pedidos: Number(row.pedidos_total ?? 0),
          comissao: Number(row.comissao_apresentadoras ?? 0) + Number(row.comissao_franquia ?? 0) + Number(row.comissao_franqueadora ?? 0),
          registros: Number(row.registros ?? 0),
        },
      }
    })
  })

  app.get('/v1/comissoes/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const { values, where } = buildComissaoFilters(request.query, tenant_id)
      const result = await db.query(
        `SELECT
           va.apresentadora_id,
           COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome, COALESCE(a.nome, 'Sem apresentadora') AS nome,
           a.foto_url AS apresentadora_foto_url,
           COALESCE(SUM(va.gmv), 0) AS gmv_total,
           COALESCE(SUM(CASE WHEN va.origem = 'live' THEN va.gmv ELSE 0 END), 0) AS gmv_lives,
           COALESCE(SUM(CASE WHEN va.origem = 'video' THEN va.gmv ELSE 0 END), 0) AS gmv_videos,
           COALESCE(SUM(va.pedidos), 0)::int AS pedidos_total,
           COUNT(*)::int AS registros,
           COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_apresentadora
         FROM vendas_atribuidas va
         LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
         WHERE ${where}
           AND va.apresentadora_id IS NOT NULL
         GROUP BY va.apresentadora_id, a.nome, a.foto_url
         ORDER BY gmv_total DESC, comissao_apresentadora DESC`,
        values,
      )
      return result.rows
    })
  })

  app.get('/v1/ranking/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const range = monthRangeFromQuery(request.query)
    const limit = limitFromQuery(request.query, 50)

    return app.withTenant(tenant_id, async (db) => {
      return getPresenterRanking(db, { tenantId: tenant_id, range, limit })
    })
  })

  // Público (sem auth) — ranking de apresentadoras de um tenant com ranking público ativo.
  // Usa app.db (pool, sem RLS) com filtro explícito de tenant_id validado.
  app.get('/v1/public/ranking/apresentadoras', async (request, reply) => {
    const tenantId = typeof request.query?.tenant === 'string' ? request.query.tenant.trim() : ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      return reply.code(400).send({ error: 'Parâmetro tenant (uuid) obrigatório' })
    }
    const range = monthRangeFromQuery(request.query)
    const limit = limitFromQuery(request.query, 10)

    const tenantQ = await app.db.query(
      `SELECT id, ranking_publico_ativo, ranking_publico_nome
         FROM tenants WHERE id = $1::uuid`,
      [tenantId],
    )
    const tenant = tenantQ.rows[0]
    if (!tenant || tenant.ranking_publico_ativo === false) {
      return reply.code(404).send({ error: 'Ranking público indisponível para esta unidade' })
    }

    return reply.send({
      unidade: tenant.ranking_publico_nome ?? null,
      mes: range.mes,
      apresentadoras: await getPresenterRanking(app.db, { tenantId, range, limit }),
    })
  })

  app.get('/v1/comissoes/marcas', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const { values, where } = buildComissaoFilters(request.query, tenant_id)
      const result = await db.query(
        `SELECT
           va.marca_id,
           m.nome AS marca_nome,
           m.tipo AS marca_tipo,
           COALESCE(m.logo_url, c.logo_url) AS logo_url,
           COALESCE(m.site, c.site) AS site,
           COALESCE(SUM(va.gmv), 0) AS gmv_total,
           COALESCE(SUM(CASE WHEN va.origem = 'live' THEN va.gmv ELSE 0 END), 0) AS gmv_lives,
           COALESCE(SUM(CASE WHEN va.origem = 'video' THEN va.gmv ELSE 0 END), 0) AS gmv_videos,
           COALESCE(SUM(va.pedidos), 0)::int AS pedidos_total,
           COUNT(*)::int AS registros,
           COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_apresentadoras,
           COALESCE(SUM(va.comissao_franquia), 0) AS comissao_franquia,
           COALESCE(SUM(va.comissao_franqueadora), 0) AS comissao_franqueadora
         FROM vendas_atribuidas va
         JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
         LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
         WHERE ${where}
         GROUP BY va.marca_id, m.nome, m.tipo, COALESCE(m.logo_url, c.logo_url), COALESCE(m.site, c.site)
         ORDER BY gmv_total DESC`,
        values,
      )
      return result.rows
    })
  })

  // GET /v1/comissoes/pendentes — lista comissões aguardando aprovação
  app.get('/v1/comissoes/pendentes', { preHandler: writeAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const { values, where } = buildComissaoFilters(request.query, tenant_id)
      const result = await db.query(
        `SELECT
           va.id,
           va.origem,
           va.origem_id,
           va.data,
           va.gmv,
           va.pedidos,
           va.comissao_apresentadora,
           va.comissao_franquia,
           va.comissao_franqueadora,
           va.status_aprovacao,
           va.criado_em,
           va.atualizado_em,
           m.nome AS marca_nome,
           COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome, COALESCE(a.nome, 'Sem apresentadora') AS nome,
           CASE
             WHEN va.apresentadora_id IS NULL THEN 'sem_apresentadora'
             WHEN va.marca_id IS NULL OR m.id IS NULL THEN 'sem_marca'
             WHEN COALESCE(va.comissao_apresentadora, 0) = 0 THEN 'comissao_zero'
             ELSE 'pronta_para_aprovar'
           END AS diagnostico_operacional,
           CASE
             WHEN va.apresentadora_id IS NULL THEN 'Sem apresentadora vinculada'
             WHEN va.marca_id IS NULL OR m.id IS NULL THEN 'Sem marca vinculada'
             WHEN COALESCE(va.comissao_apresentadora, 0) = 0 THEN 'Comissão zerada'
             ELSE 'Pronta para aprovar'
           END AS diagnostico_label
         FROM vendas_atribuidas va
         LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
         LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(va_mes.gmv), 0) + COALESCE(va.gmv, 0) AS gmv_mes
           FROM vendas_atribuidas va_mes
           WHERE va_mes.tenant_id = va.tenant_id
             AND va_mes.apresentadora_id = va.apresentadora_id
             AND date_trunc('month', va_mes.data::timestamp) = date_trunc('month', va.data::timestamp)
             AND va_mes.id <> va.id
         ) month_gmv ON true
         LEFT JOIN LATERAL (
           SELECT f.id, f.comissao_pct
           FROM apresentadora_comissao_faixas f
           WHERE f.tenant_id = va.tenant_id
             AND f.apresentadora_id = va.apresentadora_id
             AND f.ativo = true
             AND f.gmv_inicio <= COALESCE(month_gmv.gmv_mes, va.gmv, 0)
             AND (f.gmv_fim IS NULL OR f.gmv_fim >= COALESCE(month_gmv.gmv_mes, va.gmv, 0))
           ORDER BY f.gmv_inicio DESC
           LIMIT 1
         ) faixa ON true
         LEFT JOIN apresentadora_marcas am ON am.tenant_id = va.tenant_id
          AND am.marca_id = va.marca_id
          AND am.apresentadora_id = va.apresentadora_id
          AND am.ativo IS NOT FALSE
         WHERE ${where} AND va.status_aprovacao = 'pendente_aprovacao'
         ORDER BY va.data DESC, va.criado_em DESC
         LIMIT 500`,
        values,
      )
      return result.rows
    })
  })

  // PATCH /v1/comissoes/:id/aprovar — aprova comissão (somente franqueador_master / franqueado)
  app.patch('/v1/comissoes/:id/aprovar', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id, sub, papel } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const current = await db.query(
        `SELECT id, status_aprovacao FROM vendas_atribuidas
         WHERE id = $1 AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id],
      )
      if (!current.rows[0]) return reply.code(404).send({ error: 'Comissão não encontrada' })
      if (current.rows[0].status_aprovacao === 'aprovada') {
        return reply.code(409).send({ error: 'Comissão já aprovada' })
      }

      const result = await db.query(
        `UPDATE vendas_atribuidas
         SET status_aprovacao = 'aprovada',
             status_motivo    = NULL,
             aprovado_por     = $1,
             aprovado_em      = NOW(),
             atualizado_em    = NOW()
         WHERE id = $2 AND tenant_id = $3::uuid
         RETURNING id, status_aprovacao, aprovado_em`,
        [sub, request.params.id, tenant_id],
      )

      app.audit?.log?.(request, {
        action: 'comissao.aprovar',
        entity_type: 'venda_atribuida',
        entity_id: request.params.id,
        metadata: { aprovado_por: sub, papel },
      })?.catch(err => app.log.error({ err }, 'audit log failed'))

      return result.rows[0]
    })
  })

  // PATCH /v1/comissoes/:id/reprovar — reprova comissão com motivo obrigatório
  app.patch('/v1/comissoes/:id/reprovar', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id, sub, papel } = request.user
    const { motivo } = request.body ?? {}
    if (!motivo || String(motivo).trim().length < 3) {
      return reply.code(400).send({ error: 'Campo "motivo" é obrigatório para reprovar (mínimo 3 caracteres)' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const current = await db.query(
        `SELECT id, status_aprovacao FROM vendas_atribuidas
         WHERE id = $1 AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id],
      )
      if (!current.rows[0]) return reply.code(404).send({ error: 'Comissão não encontrada' })
      if (current.rows[0].status_aprovacao === 'reprovada') {
        return reply.code(409).send({ error: 'Comissão já reprovada' })
      }

      const result = await db.query(
        `UPDATE vendas_atribuidas
         SET status_aprovacao = 'reprovada',
             status_motivo    = $1,
             aprovado_por     = $2,
             aprovado_em      = NOW(),
             atualizado_em    = NOW()
         WHERE id = $3 AND tenant_id = $4::uuid
         RETURNING id, status_aprovacao, status_motivo, aprovado_em`,
        [String(motivo).trim(), sub, request.params.id, tenant_id],
      )

      app.audit?.log?.(request, {
        action: 'comissao.reprovar',
        entity_type: 'venda_atribuida',
        entity_id: request.params.id,
        metadata: { reprovado_por: sub, papel, motivo },
      })?.catch(err => app.log.error({ err }, 'audit log failed'))

      return result.rows[0]
    })
  })

  // GET /v1/lives/:id/comissoes — trio de comissões (apresentadora, franquia, franqueadora) de uma live
  app.get('/v1/lives/:id/comissoes', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { id: liveId } = request.params

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
           va.id,
           va.gmv,
           va.comissao_apresentadora,
           va.comissao_franquia,
           va.comissao_franqueadora,
           va.status_aprovacao,
           CASE WHEN va.gmv > 0
             THEN ROUND((va.comissao_apresentadora / va.gmv * 100)::numeric, 2)
             ELSE 0
           END AS pct_apresentadora,
           va.marca_id,
           m.nome AS marca_nome,
           va.apresentadora_id,
           COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome, COALESCE(a.nome, 'Sem apresentadora') AS nome
         FROM vendas_atribuidas va
         LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
         LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
         WHERE va.tenant_id = $1::uuid
           AND va.origem = 'live'
           AND va.origem_id = $2::uuid
         ORDER BY va.criado_em ASC`,
        [tenant_id, liveId],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Nenhuma comissão encontrada para essa live' })
      }

      const rows = result.rows.map((r) => ({
        ...r,
        gmv: Number(r.gmv ?? 0),
        comissao_apresentadora: Number(r.comissao_apresentadora ?? 0),
        comissao_franquia: Number(r.comissao_franquia ?? 0),
        comissao_franqueadora: Number(r.comissao_franqueadora ?? 0),
        pct_apresentadora: Number(r.pct_apresentadora ?? 0),
      }))

      return { live_id: liveId, comissoes: rows }
    })
  })

  // GET /v1/comissoes/por-live?mes=YYYY-MM — lista vendas atribuídas de live no mês
  app.get('/v1/comissoes/por-live', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { mes } = request.query ?? {}

    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return reply.code(400).send({ error: 'Parâmetro "mes" obrigatório no formato YYYY-MM' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
           va.origem_id AS live_id,
           va.data,
           va.gmv,
           va.comissao_apresentadora,
           va.comissao_franquia,
           va.comissao_franqueadora,
           va.status_aprovacao,
           CASE WHEN va.gmv > 0
             THEN ROUND((va.comissao_apresentadora / va.gmv * 100)::numeric, 2)
             ELSE 0
           END AS pct_aplicado,
           m.nome AS marca_nome,
           COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome, COALESCE(a.nome, 'Sem apresentadora') AS nome
         FROM vendas_atribuidas va
         LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
         LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
         WHERE va.tenant_id = $1::uuid
           AND va.origem = 'live'
           AND to_char(va.data::date, 'YYYY-MM') = $2
         ORDER BY va.data DESC, va.criado_em DESC`,
        [tenant_id, mes],
      )

      return result.rows.map((r) => ({
        ...r,
        gmv: Number(r.gmv ?? 0),
        comissao_apresentadora: Number(r.comissao_apresentadora ?? 0),
        comissao_franquia: Number(r.comissao_franquia ?? 0),
        comissao_franqueadora: Number(r.comissao_franqueadora ?? 0),
        pct_aplicado: Number(r.pct_aplicado ?? 0),
      }))
    })
  })
}
