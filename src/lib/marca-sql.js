// Resolução canônica da marca de uma live (mesma regra do commission-engine),
// compartilhada por financeiro (resumo + faturamento) para não haver drift.
// IMPORTANTE: SEM filtro de status — status nunca apaga dinheiro.
export const MARCA_RESOLVE_PREDICATE = 'm.id = l.marca_id'

// Canceled boundaries return zero rates, suppressing previous/legacy commercial fallback.
export function marcaResolveLateralSql(tenantParam = '$3') {
  return `LEFT JOIN LATERAL (
            SELECT m.id, m.id AS marca_id, c.id AS marca_condicao_id,
                   COALESCE(c.comissao_franquia_pct, m.comissao_franquia_pct) AS comissao_franquia_pct,
                   COALESCE(c.comissao_franqueadora_pct, m.comissao_franqueadora_pct) AS comissao_franqueadora_pct,
                   COALESCE(c.tipo_cobranca, m.tipo_cobranca, 'fixo_mais_comissao') AS tipo_cobranca,
                   COALESCE(c.comissao_janela_inicio_dia, 1) AS comissao_janela_inicio_dia
            FROM marcas m
            LEFT JOIN LATERAL (
              SELECT c.id, CASE WHEN c.cancelled_at IS NULL THEN c.comissao_franquia_pct ELSE 0 END AS comissao_franquia_pct, CASE WHEN c.cancelled_at IS NULL THEN c.comissao_franqueadora_pct ELSE 0 END AS comissao_franqueadora_pct, c.tipo_cobranca,
                      c.comissao_janela_inicio_dia
                FROM marca_condicoes_comerciais c
               WHERE c.tenant_id = ${tenantParam}::uuid
                 AND c.marca_id = m.id
                 AND c.inicio_vigencia <= (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
               ORDER BY c.inicio_vigencia DESC, c.revision DESC
               LIMIT 1
            ) c ON true
            WHERE m.tenant_id = ${tenantParam}::uuid
              AND ${MARCA_RESOLVE_PREDICATE}
            LIMIT 1
          ) mc ON true`
}
