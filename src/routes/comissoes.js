import { READ_COMISSOES } from '../config/role_groups.js'

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
  const readAccess = [app.authenticate, app.requirePapel(READ_COMISSOES)]

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
         GROUP BY va.apresentadora_id, a.nome
         ORDER BY comissao_apresentadora DESC, gmv_total DESC`,
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
}
