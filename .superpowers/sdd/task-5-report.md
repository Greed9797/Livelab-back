# Task 5 Report — Migration 117: lives.marca_id NOT NULL + FK RESTRICT + backfill

## FK Constraint Name

**Real name: `lives_marca_id_fkey`**

Source: `migrations/093_operational_source_unification.sql`, line 6:
```sql
ADD COLUMN IF NOT EXISTS marca_id UUID REFERENCES marcas(id) ON DELETE SET NULL;
```
Column added inline without explicit `CONSTRAINT` name → Postgres auto-names it `lives_marca_id_fkey`.
No later migration drops, renames, or recreates this constraint (confirmed by grepping all migrations for `lives_marca_id`, `marca_id.*FOREIGN`, `DROP CONSTRAINT.*marca`).

The migration does NOT hard-code the name. Instead, step 5's `DO $$` block queries `information_schema.referential_constraints` filtering on `delete_rule = 'SET NULL'` to find whatever the constraint is named, so it stays idempotent even if schema diverges.

## Parse Validation

```
PARSE OK — statements: 5
```
Validator: `pg-query-emscripten` (installed in node_modules).
Script wrote, ran, and deleted `_parse_check_117.mjs`. 5 top-level statements detected (2 UPDATEs + 1 DO/pre-check + 1 ALTER + 1 DO/FK-swap).

## Files Changed

- **Created**: `migrations/117_lives_marca_obrigatoria.sql`
- **Modified**: `apply_migrations.js` — added `'117_lives_marca_obrigatoria.sql'` to end of `MIGRATIONS_LIST` array

## Test Results

- `test/migrations_runner.test.js`: **4/4 passed** (includes the "includes every migration file from 016 onward" assertion that reads the real filesystem — 117 now satisfies it)
- Full suite: **401/402 passed** — 1 pre-existing flaky failure in `test/home_dashboard.test.js` (time-dependent, fails at midnight; unrelated to Task 5)

## Idempotency Analysis

| Step | Idempotent? | Mechanism |
|------|-------------|-----------|
| UPDATE backfill (cliente) | Yes | `WHERE l.marca_id IS NULL` — if already set, no rows matched |
| UPDATE backfill (afiliado/teste) | Yes | Same `WHERE l.marca_id IS NULL` guard |
| DO pre-check | Yes | RAISE only if NULL lives remain; if already fixed, COUNT=0 |
| ALTER SET NOT NULL | Yes | Postgres silently no-ops if column is already NOT NULL |
| DO FK swap | Yes | Only executes DROP+ADD when `delete_rule = 'SET NULL'` exists; re-run finds RESTRICT and skips |

## Concerns / Notes

- The `TEMP TABLE ... ON COMMIT DROP` pattern in migration 115 cannot be used here because this migration runs inside a transaction (`applyMigration` does `BEGIN`/`COMMIT`). Our migration does not use temp tables — no issue.
- The pre-check intentionally causes a hard failure (RAISE EXCEPTION) if orphan lives remain. This is by design per the plan: "listar pra correção manual". The error message includes the corrective query.
- Migration 115 already ran a similar backfill (step 6), so in prod there should be 0 NULL-marca lives at deploy time, making the pre-check a safety net only.
