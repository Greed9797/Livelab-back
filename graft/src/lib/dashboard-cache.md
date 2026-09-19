# src/lib/dashboard-cache.js

- getNamespace · function · L21-L28 — function getNamespace(name)
- buildCacheKey · function · L35-L41 — function buildCacheKey(tenantId, params = {})
- setCacheControl · function · L51-L56 — function setCacheControl(reply, cacheState, startedAt)
- readCache · function · L58-L66 — function readCache(ns, key, now)
- withCache · function · L78-L100 — async function withCache({ namespace, key, ttlMs, computeFn })
- invalidateTenant · function · L113-L124 — function invalidateTenant(tenantId, namespaceNames)
- _clearDashboardCache · function · L127-L129 — function _clearDashboardCache()
