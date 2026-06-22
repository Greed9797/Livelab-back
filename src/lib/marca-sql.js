// Resolução canônica da marca de uma live (mesma regra do commission-engine),
// compartilhada por financeiro (resumo + faturamento) para não haver drift.
// IMPORTANTE: SEM filtro de status — status nunca apaga dinheiro.
export const MARCA_RESOLVE_PREDICATE =
  '(m.id = l.marca_id OR (l.marca_id IS NULL AND m.cliente_id = l.cliente_id))'

export function marcaResolveLateralSql(tenantParam = '$3') {
  return `LEFT JOIN LATERAL (
            SELECT m.id, m.comissao_franquia_pct
            FROM marcas m
            WHERE m.tenant_id = ${tenantParam}::uuid
              AND ${MARCA_RESOLVE_PREDICATE}
            ORDER BY m.criado_em ASC
            LIMIT 1
          ) mc ON true`
}
