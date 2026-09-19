# test/live_merge_billing_concurrency.test.js

- deferred · function · L15-L19 — function deferred()
- TenantTransactionLock · class · L21-L39 — class TenantTransactionLock
- query · method · L25-L38 — async query(owner, sql, params = [])
- billingPool · function · L41-L71 — function billingPool(lock, { selected, releaseSelection } = {})
- mergeDb · function · L73-L86 — function mergeDb(lock, { reachedBoundary, releaseBoundary })
- undoDb · function · L88-L101 — function undoDb(lock, { reachedBoundary, releaseBoundary })
- nextTurn · function · L103-L105 — async function nextTurn()
