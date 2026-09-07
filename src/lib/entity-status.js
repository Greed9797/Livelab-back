// Catalog visibility only. Never use this expression to filter historical
// revenue, commissions or completed lives: deactivation does not erase work.
// A client brand cannot remain operational when its canonical client is closed.
export function marcaStatusOperacionalSql(marca = 'm', cliente = 'c') {
  return `(CASE
    WHEN ${marca}.tipo = 'cliente' AND ${cliente}.status = 'arquivado' THEN 'arquivada'
    WHEN ${marca}.tipo = 'cliente' AND ${cliente}.status IN ('cancelado', 'cancelado_automaticamente', 'reprovado') THEN 'inativa'
    ELSE ${marca}.status
  END)`
}
