// withAdvisoryLock: lock distribuído dos crons. O que não pode quebrar é o
// unlock/release — se vazar, a conexão fica presa e o job trava pra sempre.

import { describe, expect, it, vi } from 'vitest'
import { withAdvisoryLock } from '../src/jobs/advisory_lock.js'

const KEY = 123n

function makePool({ acquired }) {
  const release = vi.fn()
  const query = vi.fn(async (sql) => {
    if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ acquired }] }
    return { rows: [] }
  })
  return { pool: { connect: vi.fn(async () => ({ query, release })) }, query, release }
}

const log = () => ({ debug: vi.fn(), error: vi.fn() })

describe('withAdvisoryLock', () => {
  it('roda fn e libera lock + client quando adquire', async () => {
    const { pool, query, release } = makePool({ acquired: true })
    const fn = vi.fn().mockResolvedValue('ok')

    const out = await withAdvisoryLock(pool, KEY, '[t]', log(), fn)

    expect(out).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(query.mock.calls.some(([s]) => String(s).includes('pg_advisory_unlock'))).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('pula fn e NÃO chama unlock quando o lock está ocupado', async () => {
    const { pool, query, release } = makePool({ acquired: false })
    const fn = vi.fn()

    await withAdvisoryLock(pool, KEY, '[t]', log(), fn)

    expect(fn).not.toHaveBeenCalled()
    expect(query.mock.calls.some(([s]) => String(s).includes('pg_advisory_unlock'))).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('libera lock + client mesmo quando fn lança', async () => {
    const { pool, query, release } = makePool({ acquired: true })
    const fn = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(withAdvisoryLock(pool, KEY, '[t]', log(), fn)).rejects.toThrow('boom')

    expect(query.mock.calls.some(([s]) => String(s).includes('pg_advisory_unlock'))).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
