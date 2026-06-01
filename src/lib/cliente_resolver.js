// Helper único pra resolver cliente_id do user autenticado.
// Sempre via clientes.user_id (FK direto). NUNCA fallback por email/tenant
// — evita vazamento entre clientes do mesmo tenant.

/**
 * Retorna { id, tenant_id } do cliente vinculado ao userId no tenant do JWT,
 * ou null se inexistente. O tenant é obrigatório para evitar resolução cruzada
 * quando um mesmo usuário possui vínculos em mais de uma unidade.
 */
export async function getClienteVinculado(db, userId, tenantId) {
  if (!tenantId) {
    throw new Error('tenantId é obrigatório para resolver cliente vinculado')
  }
  const r = await db.query(
    `SELECT id, tenant_id, status
     FROM clientes
     WHERE user_id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    [userId, tenantId],
  )
  return r.rows[0] ?? null
}

/**
 * Atalho: só o id, ou null. Use quando não precisar dos demais campos.
 */
export async function getClienteId(db, userId, tenantId) {
  const r = await getClienteVinculado(db, userId, tenantId)
  return r?.id ?? null
}
