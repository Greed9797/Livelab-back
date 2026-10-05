const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function invalidScope(message) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'INVALID_FINANCEIRO_LIQUIDACOES_SCOPE'
  return error
}

function validarEscopo({ tenantId, origemTipo, origemId }) {
  if (!RE_UUID.test(String(tenantId ?? ''))) throw invalidScope('tenantId inválido')
  if (typeof origemTipo !== 'string' || origemTipo.trim() === '') throw invalidScope('origemTipo é obrigatório')
  if (!RE_UUID.test(String(origemId ?? ''))) throw invalidScope('origemId inválido')
}

const BASE_CTE = `
  WITH estornos_por_liquidacao AS (
    SELECT
      e.tenant_id,
      e.liquidacao_id,
      SUM(e.valor)::numeric(15,2) AS total_estornado
    FROM financeiro_estornos e
    WHERE e.tenant_id = $1::uuid
    GROUP BY e.tenant_id, e.liquidacao_id
  ),
  liquidacoes_escopo AS (
    SELECT
      l.id,
      l.tenant_id,
      l.valor,
      l.data_liquidacao,
      COALESCE(e.total_estornado, 0::numeric)::numeric(15,2) AS total_estornado
    FROM financeiro_liquidacoes l
    LEFT JOIN estornos_por_liquidacao e
      ON e.tenant_id = l.tenant_id
     AND e.liquidacao_id = l.id
    WHERE l.tenant_id = $1::uuid
      AND l.origem_tipo = $2
      AND l.origem_id = $3::uuid
  )
`

/**
 * Leitura canônica mínima de liquidações FIN-03A/03B por obrigação.
 *
 * Dinheiro permanece no PostgreSQL como NUMERIC e sai como texto decimal exato.
 * Nenhum total global é consultado; o escopo é sempre tenant + origem_tipo + origem_id.
 */
export async function lerLiquidacoesOrigem(
  db,
  { tenantId, origemTipo, origemId, listarDatas = false } = {},
) {
  validarEscopo({ tenantId, origemTipo, origemId })

  const params = [tenantId, origemTipo.trim(), origemId]
  if (listarDatas) {
    // Um único statement mantém totais e detalhes no mesmo snapshot de leitura.
    const { rows } = await db.query(
      `WITH liquidacoes_escopo AS (
         SELECT id, tenant_id, valor, data_liquidacao
           FROM financeiro_liquidacoes
          WHERE tenant_id = $1::uuid
            AND origem_tipo = $2
            AND origem_id = $3::uuid
       ), estornos_por_liquidacao AS (
         SELECT e.liquidacao_id,
                SUM(e.valor)::numeric(15,2) AS total_estornado,
                jsonb_agg(jsonb_build_object(
                  'id', e.id,
                  'valor', e.valor::numeric(15,2)::text,
                  'data_estorno', to_char(e.data_estorno, 'YYYY-MM-DD')
                ) ORDER BY e.data_estorno, e.id) AS estornos
           FROM financeiro_estornos e
           JOIN liquidacoes_escopo l
             ON l.tenant_id = e.tenant_id AND l.id = e.liquidacao_id
          GROUP BY e.liquidacao_id
       ), detalhes AS (
         SELECT l.id, l.valor, l.data_liquidacao,
                COALESCE(e.total_estornado, 0::numeric)::numeric(15,2) AS total_estornado,
                COALESCE(e.estornos, '[]'::jsonb) AS estornos
           FROM liquidacoes_escopo l
           LEFT JOIN estornos_por_liquidacao e ON e.liquidacao_id = l.id
       )
       SELECT
         COALESCE(SUM(valor), 0::numeric)::numeric(15,2)::text AS total_liquidado,
         COALESCE(SUM(total_estornado), 0::numeric)::numeric(15,2)::text AS total_estornado,
         COALESCE(SUM(valor - total_estornado), 0::numeric)::numeric(15,2)::text AS total_liquido,
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', id,
           'valor', valor::numeric(15,2)::text,
           'data_liquidacao', to_char(data_liquidacao, 'YYYY-MM-DD'),
           'total_estornado', total_estornado::numeric(15,2)::text,
           'total_liquido', (valor - total_estornado)::numeric(15,2)::text,
           'estornos', estornos
         ) ORDER BY data_liquidacao, id), '[]'::jsonb) AS liquidacoes
       FROM detalhes`,
      params,
    )
    return rows[0]
  }

  const { rows } = await db.query(
    `${BASE_CTE}
    SELECT
      COALESCE(SUM(valor), 0::numeric)::numeric(15,2)::text AS total_liquidado,
      COALESCE(SUM(total_estornado), 0::numeric)::numeric(15,2)::text AS total_estornado,
      COALESCE(SUM(valor - total_estornado), 0::numeric)::numeric(15,2)::text AS total_liquido
    FROM liquidacoes_escopo`,
    params,
  )

  return {
    total_liquidado: rows[0].total_liquidado,
    total_estornado: rows[0].total_estornado,
    total_liquido: rows[0].total_liquido,
  }
}
