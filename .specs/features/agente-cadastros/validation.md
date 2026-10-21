## Validation: PASS

# Agente de atualização cadastral

**Date**: 2026-10-21  
**Spec**: `.specs/features/agente-cadastros/spec.md`  
**Diff range**: `e718793..d24ceac980204cc19b0e59a6234dfc086549246e`  
**Verifier**: independent sub-agent, author ≠ verifier

The feature meets all eight acceptance criteria. The first CI run exposed an exact-export compatibility regression; it was fixed in `132ddcf`. Commit `d24ceac` adds real-SQL detail-read, cross-tenant detail, and partial-update assertions without changing runtime source.

## Gate

GitHub Actions run `39620918729`, job `119293738673`, completed successfully on `d24ceac980204cc19b0e59a6234dfc086549246e`: syntax, fresh schema setup, migrations, coverage, the full Vitest suite, PGlite SQL fixtures, and production dependency audit all passed. It reported **2183 passed, 0 failed, 67 pre-existing skips** (7 RLS tests run under CI rather than joining the local skips), in 228 files. Coverage was 70.72% statements, 64.41% branches, 74.23% functions, and 73.76% lines. The feature adds two test files with seven cases; the diff removes no tests. No local full-suite result is claimed.

`git diff --check e718793..d24ceac` was clean. The feature diff has no `migrations/`, `apply_migrations.js`, `package.json`, or new service module change. The existing human-user role constraint excludes `automacao_cadastros` (`migrations/048_users_management.sql:4`), while machine-key roles live in `api_keys.papel` (`migrations/138_api_keys.sql:17`).

## Spec-anchored acceptance criteria

| Criterion | Spec-defined outcome | Evidence: implementation and exact assertion | Result |
| --- | --- | --- | --- |
| AGCAD-1: administrator creates `cadastros` key | Persists `automacao_cadastros`, retains existing hash, expiry, and revocation mechanics | `src/routes/api_keys.js:25,37-40` maps the new scope and validates it; `src/plugins/auth.js:355-370` still hashes, finds, expires, and revokes keys. `test/agente_cadastros.test.js:127-133` asserts 201, scope, role, SHA-256 hash length, non-plaintext storage, and inserted role. | ✅ PASS |
| AGCAD-2: only three exact routes and methods | GET collection/detail and PATCH detail with a UUID; every other method or route is 403 | `src/plugins/auth.js:146-158,197-212,374-379` has the three-entry role-specific allowlist, anchored UUID matching, and default denial. `test/agente_cadastros.test.js:51-58` asserts the three allows plus POST, promotion, and `/marcas` denials; `test/agente_cadastros.test.js:85-99` injects the real auth plugin and asserts GET/PATCH 200 and POST/lives 403. | ✅ PASS |
| AGCAD-3: tenant isolation | The key tenant is the only tenant queried; cross-tenant ID returns 404 and cannot change data | `src/services/cadastros.js:196-228,235-252` explicitly filters both list/detail resolution and DTO queries by `tenant_id`; `src/routes/cadastros.js:51-55,74-81,108-139` passes `request.user.tenant_id`. `test/agente_cadastros.pglite.test.js:83-100,146-149` asserts one tenant list row, cross-tenant detail 404, cross-tenant PATCH 404, and unchanged foreign data. | ✅ PASS |
| AGCAD-4: restricted response and cache isolation | Only IDs plus permitted cadastro fields; no commercial, gateway, presenter, credential, or login data; `private, no-store` | `src/services/cadastros.js:187-228` constructs a fixed DTO from the 17 allowed fields; `src/routes/cadastros.js:53-55,77-81` bypasses the shared cache and sets `private, no-store`; `src/plugins/auth.js:242-248,372-379` carries the header through negative and failed-key paths. `test/agente_cadastros.pglite.test.js:86-100` asserts the exact collection DTO, successful detail equality, and `no-store` on both successful and foreign 404 details; `test/agente_cadastros.test.js:85-97,102-115` asserts `no-store` on denied, invalid, expired, and revoked-key requests. | ✅ PASS |
| AGCAD-5: validate PATCH before writing | Exactly the listed cadastro fields and a trimmed 1–500-character `referencia_documento`; forbidden fields 403, invalid input 400, no write first | `src/services/cadastros.js:87-129` has the 17-field allowlist, strict schema, reference bounds, 403 forbidden-field result, and 400 invalid result; `src/routes/cadastros.js:108-117` validates before acquiring the tenant database callback. `test/agente_cadastros.test.js:60-75` asserts missing/overlong reference 400, financial field 403, and zero SQL calls; `test/agente_cadastros.pglite.test.js:151-156` asserts 403 for `status`. | ✅ PASS |
| AGCAD-6: synchronized update and atomic audit | Existing cliente/marca/TikTok synchronization is reused; omitted fields are preserved; before/after plus reference are audited in the same transaction and audit failure rolls back | `src/services/cadastros.js:439-551` keeps the existing sparse `d` update, client/brand mirror logic, canonical TikTok update, transaction, and pre-commit callback; `src/routes/cadastros.js:120-145` records the changed-field before/after snapshot and document reference; `src/plugins/audit_log.js:28-68` writes through the supplied transaction connection and rethrows in strict mode. `test/agente_cadastros.pglite.test.js:102-144` asserts all 17 fields, zero/false preservation, client synchronization, key identity, reference, PII redaction, then a one-field `cidade` PATCH that preserves the complete prior DTO and audits only that field. `test/agente_cadastros.pglite.test.js:159-165` forces a real audit-table constraint failure, then asserts 500, unchanged marca/client data, and zero audit rows. | ✅ PASS |
| AGCAD-7: old scopes, client portal, and invalid keys retain restrictions | Old operational key stays read-only; finance key gets no cadastro access; client portal allowlist remains closed; invalid/expired/revoked keys return 401 | `src/plugins/auth.js:152-158` keeps scope separation and `src/routes/cadastros.js:47-49` only adds the new machine role locally. Existing assertions at `test/cadastros_routes.test.js:97-106` preserve old-key GET-only and finance denial; `test/cliente_portal_access.test.js:90-149` preserves portal 403/401/no-store handling. `test/agente_cadastros.test.js:102-115` asserts all three invalid-key states return 401. | ✅ PASS |
| AGCAD-8: real SQL, mocks, real auth, gate, independent review, and ≥5 scratch mutations | SQL PGlite, mocks, real auth, full suite, independent review, and at least five meaningful mutants killed | Mock and real-auth coverage is in `test/agente_cadastros.test.js:17-46,49-135`; real SQL PGlite coverage is in `test/agente_cadastros.pglite.test.js:24-35,80-166`. The complete CI gate is recorded above. Five valid behavior mutants were run serially in isolated worktrees and all were killed, documented below. | ✅ PASS |

## Regression and quality review

| Check | Result | Evidence |
| --- | --- | --- |
| Legacy role-group export contract | ✅ | Initial CI found the exact-export failure. `132ddcf` keeps the arrays route-local at `src/routes/cadastros.js:47-48`; final CI is green. |
| Client portal restriction | ✅ | `src/plugins/auth.js:290-328` is unchanged in behavior; `test/cliente_portal_access.test.js:90-149` exercises blocked and revoked client sessions. |
| Old API-key scopes | ✅ | `test/cadastros_routes.test.js:97-106` covers existing operational and finance behavior. |
| No migrations, new services, or unrelated schema work | ✅ | Diff inventory and gate review above. |
| Scope and implementation shape | ✅ | The change reuses the key, authentication, cadastro, transaction, and audit mechanisms. The only dependency delta is the compatible `follow-redirects` lockfile security patch. |
| Test ownership | ✅ | Every new test maps to AGCAD-1 through AGCAD-8, a listed edge case, or the CI requirement. |

## Discrimination sensors

All mutations were made only in a disposable detached worktree at `132ddcf`, run serially with one worker, then removed. The real worktree was clean before and after. One invalid isolation attempt was discarded because removing `$1` caused a bind-parameter failure; it is not counted.

| Mutation | Focused test | Result |
| --- | --- | --- |
| Removed `PATCH /v1/cadastros/:id` from the cadastro-key allowlist | `test/agente_cadastros.test.js` | ✅ Killed: allowlist assertion failed at line 54 and real authenticated PATCH expectation failed at line 95. |
| Replaced the list tenant predicate with `(m.tenant_id = $1::uuid OR TRUE)` while retaining binding | `test/agente_cadastros.pglite.test.js` | ✅ Killed: request remained 200 but returned two rows; exact isolation assertion failed at line 87. |
| Changed forbidden-field result from 403 to 400 | Both feature test files | ✅ Killed: exact 403 assertions failed at `test/agente_cadastros.test.js:69` and `test/agente_cadastros.pglite.test.js:155`. |
| Changed strict audit write to non-strict | `test/agente_cadastros.pglite.test.js` | ✅ Killed: forced audit constraint failure returned 200 instead of 500 at line 162. |
| Disabled audit PII scrubbing | `test/agente_cadastros.pglite.test.js` | ✅ Killed: sensitive before-value was exposed; redaction assertion failed at line 130. |

No mutant survived. No lessons entry is required because validation completed cleanly with no surviving mutant, uncovered criterion, or spec-precision gap.
