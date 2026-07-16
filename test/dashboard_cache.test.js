import { describe, expect, it } from 'vitest'

import { buildCacheKey, invalidateTenant, setCacheControl, withCache, _clearDashboardCache } from '../src/lib/dashboard-cache.js'

function fakeReply() {
  const headers = {}
  return { headers, header: (name, value) => { headers[name] = value } }
}

describe('dashboard-cache', () => {
  it('never lets the browser cache the response', () => {
    // Regressão: com `max-age` o browser servia a lista antiga por 15s (45s com
    // stale-while-revalidate) logo depois de um PATCH — o refetch nem chegava ao
    // servidor, e a edição parecia não ter salvo.
    const reply = fakeReply()
    setCacheControl(reply, 'HIT', 0)

    expect(reply.headers['Cache-Control']).toBe('private, no-cache')
    expect(reply.headers['Cache-Control']).not.toContain('max-age')
    expect(reply.headers['Cache-Control']).not.toContain('stale-while-revalidate')
  })

  it('serves a write-invalidated key from the database again', async () => {
    _clearDashboardCache()
    const tenant = 'tenant-a'
    let hits = 0
    const compute = async () => ({ n: ++hits })
    const call = () => withCache({ namespace: 'marcas:list', key: buildCacheKey(tenant, { status: 'ativa' }), ttlMs: 300_000, computeFn: compute })

    expect((await call()).state).toBe('MISS')
    expect((await call()).state).toBe('HIT')

    invalidateTenant(tenant)

    const afterWrite = await call()
    expect(afterWrite.state).toBe('MISS')
    expect(afterWrite.value).toEqual({ n: 2 })
  })

  it('keeps one tenant invalidation from clearing another tenant', async () => {
    _clearDashboardCache()
    const compute = async () => ({ ok: true })
    const call = (tenant) => withCache({ namespace: 'marcas:list', key: buildCacheKey(tenant, {}), ttlMs: 300_000, computeFn: compute })

    await call('tenant-a')
    await call('tenant-b')
    invalidateTenant('tenant-a')

    expect((await call('tenant-a')).state).toBe('MISS')
    expect((await call('tenant-b')).state).toBe('HIT')
  })
})
