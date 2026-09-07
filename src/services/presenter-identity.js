export function isPresenterRole(papel) {
  return papel === 'apresentador' || papel === 'apresentadora'
}

export function presenterIdentityConflict() {
  const error = new Error('Há mais de um perfil de apresentadora vinculado ao mesmo usuário. Corrija o vínculo antes de editar.')
  error.statusCode = 409
  error.code = 'PRESENTER_IDENTITY_AMBIGUOUS'
  return error
}

/**
 * Resolves either a presenter id or a user id without provisioning records.
 * Legacy duplicates are an explicit repair case, never an arbitrary first row.
 */
export async function resolvePresenterId(db, tenantId, rawId, { forUpdate = false } = {}) {
  const lock = forUpdate ? ' FOR UPDATE' : ''
  const byId = await db.query(
    `SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid LIMIT 2${lock}`,
    [rawId, tenantId],
  )
  if (byId.rows.length > 1) throw presenterIdentityConflict()
  if (byId.rows[0]) return byId.rows[0].id

  const byUser = await db.query(
    `SELECT id FROM apresentadoras WHERE user_id = $1 AND tenant_id = $2::uuid LIMIT 2${lock}`,
    [rawId, tenantId],
  )
  if (byUser.rows.length > 1) throw presenterIdentityConflict()
  return byUser.rows[0]?.id ?? null
}

export async function linkedPresenterForUser(db, tenantId, userId, { forUpdate = false } = {}) {
  const lock = forUpdate ? ' FOR UPDATE' : ''
  const result = await db.query(
    `SELECT id, user_id, nome, email, ativo, arquivada, fixo, comissao_pct, foto_url
       FROM apresentadoras
      WHERE tenant_id = $1::uuid AND user_id = $2::uuid
      LIMIT 2${lock}`,
    [tenantId, userId],
  )
  if (result.rows.length > 1) throw presenterIdentityConflict()
  return result.rows[0] ?? null
}
