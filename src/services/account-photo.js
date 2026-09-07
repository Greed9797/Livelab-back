// Only look up the authenticated account's explicit, unique profile link.
// Keep image payloads out of JWTs (legacy photos may be large data URLs).
export async function getAccountPhoto(db, { id, tenant_id: tenantId, papel }) {
  if (!['apresentador', 'apresentadora'].includes(papel)) return null
  const result = await db.query(`SELECT foto_url FROM apresentadoras
    WHERE user_id=$1::uuid AND tenant_id=$2::uuid
      AND ativo IS TRUE AND arquivada IS NOT TRUE
    LIMIT 2`, [id, tenantId])
  return result.rows.length === 1 ? result.rows[0].foto_url ?? null : null
}
