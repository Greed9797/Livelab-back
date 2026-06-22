# Task 7 Report — reprocessar_todas_comissoes.js

## Connection / RLS Pattern Used

**Source:** `scripts/backfill_comissoes_unificacao.js:14-22` (pool creation) and lines `52-54` (RLS pattern).
Also confirmed in `src/jobs/recalcular_comissoes.js:62-64` and `109-113`.

**Pool creation** (copies `backfill_comissoes_unificacao.js`):
```js
import pg from 'pg'
import { resolveDbSslConfig } from '../src/utils/db-ssl.js'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveDbSslConfig(process.env.DATABASE_URL),
  ...
})
```

**RLS pattern** (transaction-local `set_config`):
```js
await client.query('BEGIN')
await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [live.tenant_id])
// ... engine calls ...
await client.query('COMMIT')
```

The `true` argument makes `set_config` transaction-local — it resets when the transaction ends, preventing tenant bleed between iterations. Pattern identical to `recalcular_comissoes.js:62-64` and `backfill_comissoes_unificacao.js:52-53`.

## node --check Result

```
PARSE OK
```

## Vitest Suite

```
Test Files  1 failed | 62 passed (63)
      Tests  1 failed | 401 passed (402)
```

Only the pre-existing `home_dashboard.test.js` flaky failure (time-dependent, runs after midnight). Script is not imported by any test and caused zero regressions.

## Concerns for Production Run

1. **Runtime estimate:** Queries ALL `status='encerrada'` lives in one batch (no LIMIT). With potentially hundreds of lives, expect 30-120s. Each live spawns 3–5 DB round-trips in the engine. Acceptable for a one-off.

2. **Batching:** No chunking — all lives fetched in one SELECT then processed sequentially. If the tenant has thousands of lives, memory footprint is low (rows are small) but runtime may extend. Could add `LIMIT`/`OFFSET` if needed.

3. **Idempotence:** Safe to re-run. `calcularComissoesDaLive` uses `ON CONFLICT ... DO UPDATE ... WHERE status_aprovacao != 'aprovada'` — approved rows are never overwritten.

4. **Status filter:** Uses `status='encerrada'` per Fase 1 constraints. Fase 2 will change the finalized status; the script will need updating then.

5. **No cross-tenant contamination:** Each live gets its own connection + `BEGIN` + `set_config(..., true)` (transaction-local). Connection is released in `finally` even on error.

6. **Run timing:** Should be run after Task 6 deploys (engine `throw` on missing marca). Lives without marca will appear as failures (listed by ID), enabling targeted manual fix.
