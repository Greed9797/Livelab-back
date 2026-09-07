import { describe, expect, it, vi } from 'vitest'
import { withPortalPresenterDb } from '../src/services/portal-apresentadora-db.js'

const tenant = '11111111-1111-4111-8111-111111111111'

describe('portal runtime role executor', () => {
  it('uses one transaction-local role and tenant context, then releases the client', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const release = vi.fn()
    const app = { db: { pool: { connect: vi.fn(async () => ({ query, release })) } } }
    const value = await withPortalPresenterDb(app, tenant, async (db) => {
      expect(db.inPortalTransaction).toBe(true)
      await db.query('SELECT 42')
      return 'ok'
    })
    expect(value).toBe('ok')
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE livelab_portal_runtime',
      "SELECT set_config('app.tenant_id', $1, true)",
      'SELECT 42',
      'COMMIT',
    ])
    expect(release).toHaveBeenCalledWith(undefined)
  })

  it('rolls back and never invokes work when SET LOCAL ROLE fails', async () => {
    const failure = new Error('role missing')
    const query = vi.fn(async (sql) => {
      if (sql === 'SET LOCAL ROLE livelab_portal_runtime') throw failure
      return { rows: [] }
    })
    const release = vi.fn()
    const work = vi.fn()
    const app = { db: { pool: { connect: vi.fn(async () => ({ query, release })) } } }
    await expect(withPortalPresenterDb(app, tenant, work)).rejects.toMatchObject({ statusCode: 503, code: 'PORTAL_RUNTIME_UNAVAILABLE' })
    expect(work).not.toHaveBeenCalled()
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SET LOCAL ROLE livelab_portal_runtime', 'ROLLBACK'])
    expect(release).toHaveBeenCalledWith(undefined)
  })

  it('destroys the checked-out client when rollback cleanup fails', async () => {
    const workFailure = new Error('write failed')
    const rollbackFailure = new Error('connection lost during rollback')
    const query = vi.fn(async (sql) => {
      if (sql === 'SELECT fail') throw workFailure
      if (sql === 'ROLLBACK') throw rollbackFailure
      return { rows: [] }
    })
    const release = vi.fn()
    const app = { db: { pool: { connect: vi.fn(async () => ({ query, release })) } } }
    await expect(withPortalPresenterDb(app, tenant, (db) => db.query('SELECT fail'))).rejects.toBe(workFailure)
    expect(release).toHaveBeenCalledWith(rollbackFailure)
  })
})
