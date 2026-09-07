import { assertTenantId } from '../plugins/db.js'

// A role no-login is intentionally assumed only for portal requests.  It keeps
// the current application credential available to the rest of the API while
// making every portal query obey RLS under a least-privilege identity.
export const PORTAL_RUNTIME_ROLE = 'livelab_portal_runtime'

/**
 * Runs one portal request in a transaction with a transaction-local role and
 * tenant GUC.  There is deliberately no fallback to app.withTenant/app.db:
 * absent role grants must fail closed rather than execute as the BYPASSRLS
 * application owner.
 *
 * Portal handlers can use `db.inPortalTransaction` to avoid opening a nested
 * BEGIN for state transitions; the surrounding transaction is their atomic
 * boundary.
 */
export async function withPortalPresenterDb(app, tenantId, work) {
  assertTenantId(tenantId, 'withPortalPresenterDb')
  const pool = app.db?.pool
  if (!pool?.connect) {
    const error = new Error('Executor isolado do portal não está disponível')
    error.statusCode = 503
    throw error
  }

  const client = await pool.connect()
  let transactionOpen = false
  let releaseError = null
  let contextEstablished = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    await client.query(`SET LOCAL ROLE ${PORTAL_RUNTIME_ROLE}`)
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
    contextEstablished = true

    const result = await work({
      query: (text, params) => client.query(text, params),
      inPortalTransaction: true,
    })

    await client.query('COMMIT')
    transactionOpen = false
    return result
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        releaseError = rollbackError
      }
    }
    if (!contextEstablished) {
      error.statusCode = 503
      error.code = error.code ?? 'PORTAL_RUNTIME_UNAVAILABLE'
    }
    throw error
  } finally {
    // SET LOCAL is reset by COMMIT/ROLLBACK. If cleanup itself failed, destroy
    // the checked-out connection instead of returning uncertain role/GUC state
    // to the shared pool.
    client.release(releaseError ?? undefined)
  }
}
