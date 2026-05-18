import { READ_COMISSOES } from '../config/role_groups.js'

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
           COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome,
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
         GROUP BY va.apresentadora_id, a.nome
         ORDER BY gmv_total DESC, comissao_apresentadora DESC`,
        values,
      )
      return result.rows
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
         WHERE ${where}
         GROUP BY va.marca_id, m.nome, m.tipo
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
           COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome
         FROM vendas_atribuidas va
         JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
         LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
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
}
