import { describe, expect, it, vi } from 'vitest'
import { linkedPresenterForUser, presenterIdentityConflict, resolvePresenterId } from '../src/services/presenter-identity.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const presenter = '22222222-2222-4222-8222-222222222222'
const user = '33333333-3333-4333-8333-333333333333'

describe('presenter identity resolver', () => {
  it('resolves a user-linked profile without provisioning or writes', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('WHERE id = $1')) return { rows: [] }
      if (sql.includes('WHERE user_id = $1')) return { rows: [{ id: presenter }] }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    await expect(resolvePresenterId({ query }, tenant, user)).resolves.toBe(presenter)
    expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/i.test(sql))).toBe(false)
  })

  it('rejects ambiguous legacy links instead of picking an arbitrary profile', async () => {
    const query = vi.fn(async (sql) => ({ rows: sql.includes('WHERE user_id') ? [{ id: presenter }, { id: user }] : [] }))
    await expect(resolvePresenterId({ query }, tenant, user)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRESENTER_IDENTITY_AMBIGUOUS',
    })
  })

  it('detects duplicate profiles while resolving a linked user', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: presenter }, { id: user }] }))
    await expect(linkedPresenterForUser({ query }, tenant, user, { forUpdate: true })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRESENTER_IDENTITY_AMBIGUOUS',
    })
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE')
  })

  it('marks the conflict as a repair flow rather than an internal error', () => {
    expect(presenterIdentityConflict()).toMatchObject({ statusCode: 409, code: 'PRESENTER_IDENTITY_AMBIGUOUS' })
  })
})
