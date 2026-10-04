// Catalog visibility only. Never use this expression to filter historical
// revenue, commissions or completed lives: deactivation does not erase work.
// A client brand cannot remain operational when its canonical client is closed.
//
// `considerarExcluido`: cliente soft-deletado (clientes.deleted_at, migration 077)
// conta como 'arquivada'. Opt-in de propósito: o papel livelab_portal_runtime
// (migration 145) só tem SELECT em clientes(id, tenant_id, status, logo_url) — ler
// deleted_at nas queries do portal da apresentadora daria "permission denied".
// Rotas de gestão (marcas, cadastros) passam true.
export function marcaStatusOperacionalSql(marca = 'm', cliente = 'c', { considerarExcluido = false } = {}) {
  const excluido = considerarExcluido
    ? `\n    WHEN ${marca}.tipo = 'cliente' AND ${cliente}.deleted_at IS NOT NULL THEN 'arquivada'`
    : ''
  return `(CASE${excluido}
    WHEN ${marca}.tipo = 'cliente' AND ${cliente}.status = 'arquivado' THEN 'arquivada'
    WHEN ${marca}.tipo = 'cliente' AND ${cliente}.status IN ('cancelado', 'cancelado_automaticamente', 'reprovado') THEN 'inativa'
    ELSE ${marca}.status
  END)`
}
