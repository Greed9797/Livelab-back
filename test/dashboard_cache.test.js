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

describe('dashboard-cache: geração por tenant', () => {
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

  it('compute iniciado antes da invalidação não grava no cache', async () => {
    _clearDashboardCache()
    const gate = deferred()
    let n = 0
    const key = buildCacheKey('tenant-g', { a: 1 })
    const call = () => withCache({
      namespace: 'gen:test', key, ttlMs: 300_000,
      computeFn: async () => { const v = ++n; if (v === 1) await gate.promise; return { v } },
    })
    const lenta = call() // começa na geração 0 e fica pendurada
    await Promise.resolve()
    invalidateTenant('tenant-g') // escrita aconteceu enquanto o compute rodava
    gate.resolve()
    expect((await lenta).value).toEqual({ v: 1 }) // quem pediu antes recebe o que computou…

    const depois = await call() // …mas nada foi gravado: recomputa
    expect(depois.state).toBe('MISS')
    expect(depois.value).toEqual({ v: 2 })
    expect((await call()).state).toBe('HIT') // o compute pós-invalidação grava normalmente
  })

  it('quem chega depois da invalidação não se junta ao in-flight antigo', async () => {
    _clearDashboardCache()
    const gate = deferred()
    let n = 0
    const key = buildCacheKey('tenant-h', {})
    const call = () => withCache({
      namespace: 'gen:test', key, ttlMs: 300_000,
      computeFn: async () => { const v = ++n; if (v === 1) await gate.promise; return { v } },
    })
    const velha = call()
    await Promise.resolve()
    invalidateTenant('tenant-h')
    const nova = await call()
    expect(nova.value).toEqual({ v: 2 })
    gate.resolve()
    await velha
    // a resposta velha terminou depois e não sobrescreve a nova no cache
    expect((await call()).value).toEqual({ v: 2 })
  })

  it('invalidar um tenant não impede o outro de gravar', async () => {
    _clearDashboardCache()
    const gate = deferred()
    const key = buildCacheKey('tenant-i', {})
    const p = withCache({ namespace: 'gen:test', key, ttlMs: 300_000, computeFn: async () => { await gate.promise; return 1 } })
    await Promise.resolve()
    invalidateTenant('tenant-j')
    gate.resolve()
    await p
    expect((await withCache({ namespace: 'gen:test', key, ttlMs: 300_000, computeFn: async () => 2 })).state).toBe('HIT')
  })
})
