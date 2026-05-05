// Helper único pra resolver cliente_id do user autenticado.
// Sempre via clientes.user_id (FK direto). NUNCA fallback por email/tenant
// — evita vazamento entre clientes do mesmo tenant.

/**
 * Retorna { id, tenant_id } do cliente vinculado ao userId, ou null se inexistente.
 */
export async function getClienteVinculado(db, userId) {
  const r = await db.query(
    `SELECT id, tenant_id, status FROM clientes WHERE user_id = $1 LIMIT 1`,
    [userId],
  )
  return r.rows[0] ?? null
}

/**
 * Atalho: só o id, ou null. Use quando não precisar dos demais campos.
 */
export async function getClienteId(db, userId) {
  const r = await getClienteVinculado(db, userId)
  return r?.id ?? null
}
