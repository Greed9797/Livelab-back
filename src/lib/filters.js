// Helpers de filtro reutilizáveis para listagens GET.
// Causa raiz: soft-delete (status='cancelado' ou ativo=false) vaza em listagens
// sem filtro default, fazendo o registro reaparecer após DELETE.
//
// Contrato: cliente que precisa ver registros soft-deletados passa opt-in:
//   - agenda: ?status=all
//   - entidades com coluna ativo: ?include_inactive=true

/**
 * Aplica filtro de status para agenda_eventos.
 *
 * - status === 'all'   → bypass (admin/auditor pode ver cancelados)
 * - status definido    → filtra valor exato
 * - status ausente     → default exclui 'cancelado'
 *
 * @param {string[]} filters - array de cláusulas WHERE (mutado)
 * @param {string[]} values - array de parâmetros (mutado quando status exato)
 * @param {string|undefined} status - request.query.status
 * @param {string} alias - alias da tabela na query (default 'ae')
 */
export function applyAgendaStatusFilter(filters, values, status, alias = 'ae') {
  if (status === 'all') return
  if (status) {
    values.push(status)
    filters.push(`${alias}.status = $${values.length}`)
    return
  }
  filters.push(`${alias}.status <> 'cancelado'`)
}

/**
 * Aplica filtro de coluna `ativo` para entidades soft-deletáveis.
 *
 * - include_inactive=true → bypass
 * - default              → exclui ativo=false (cobre true e NULL via IS NOT FALSE)
 *
 * @param {string[]} filters - array de cláusulas WHERE (mutado)
 * @param {object} query - request.query
 * @param {string} qualifiedColumn - ex: 'a.ativo' ou 'cabines.ativo'
 */
export function applyActiveFilter(filters, query, qualifiedColumn) {
  const includeInactive = String(query?.include_inactive ?? '').toLowerCase() === 'true'
  if (includeInactive) return
  filters.push(`${qualifiedColumn} IS NOT FALSE`)
}
