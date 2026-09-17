// A shared, bounded probe keeps public monitoring from exhausting the DB pool.
export function createReadinessProbe(db, { timeoutMs = 3000, cacheMs = 5000 } = {}) {
  let pending = null
  let cached = null
  return async function probe() {
    if (cached && cached.until > Date.now()) return cached.ok
    if (!pending) {
      pending = Promise.resolve().then(() => db.query({ text: 'SELECT 1', query_timeout: timeoutMs }))
        .then(() => true, () => false)
        .then((ok) => { cached = { ok, until: Date.now() + cacheMs }; return ok })
        .finally(() => { pending = null })
    }
    let timer
    try {
      const ok = await Promise.race([
        pending,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
      ])
      cached = { ok, until: Date.now() + cacheMs }
      return ok
    } finally { clearTimeout(timer) }
  }
}

export function registerReadiness(app, { storageProbe, storageTimeoutMs = 1000 } = {}) {
  const probe = createReadinessProbe(app.db)
  app.get('/readyz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const ok = await probe()
    let storage
    if (storageProbe) {
      let timer
      try {
        storage = await Promise.race([
          Promise.resolve().then(storageProbe),
          new Promise(resolve => {
            timer = setTimeout(() => resolve({ configured: true, ok: false }), storageTimeoutMs)
          }),
        ])
      } catch {
        storage = { configured: true, ok: false }
      } finally {
        clearTimeout(timer)
      }
    }
    return reply.code(ok ? 200 : 503).send({
      ok,
      storage: storage ? { configured: storage.configured, ok: storage.ok } : undefined,
    })
  })
}
