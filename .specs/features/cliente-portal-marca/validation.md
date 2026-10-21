# Cliente portal por marca: PASS

**Date**: 2026-10-21
**Verifier**: independent final verifier
**Backend range**: `b987be35afb4bacd8f8160970b7ec3ba8c7e5506..4e3d690158c7501cc8d2a9f67810dbe83d1907e2`
**Frontend range reviewed**: `ff3df3347d5db81c226f52d5b163b3c02de3e7e7..14bafb0bf65aee1b756a31c23e70fdc8238b88b7`

All ten acceptance criteria have executable, spec-matching evidence. The API fails closed at the account, tenant, client, brand, route, and session boundaries. No production, network-write, deployment, migration, credential, or real-database action was performed.

## Task completion

| Task | Status | Evidence |
| --- | --- | --- |
| T1 | Done | Route/session isolation assertions in `test/cliente_portal_access.test.js:56-149`; actual legacy PDF registration assertion at `:90-100`. |
| T2 | Done | Real PGlite isolation, DTO, pagination, null, zero, and date assertions in `test/cliente_portal_revisado.pglite.test.js:62-150`. |
| T3 | Done | Full backend gate below; no migration, dependency, or deployment configuration file occurs in the diff. |
| T4 | Done | Independent outcome check, six scratch mutations, and clean-tree verification below. |

## Spec-anchored acceptance criteria

| ID | Spec-defined outcome | Evidence and exact assertion | Result |
| --- | --- | --- | --- |
| PORTAL-1 | Exactly one client and one contracted brand in JWT tenant; missing or ambiguous links are 403. | Resolver requires exactly one row at `src/lib/cliente_resolver.js:41-59`; `test/cliente_portal_perfil.test.js:40-53` asserts all missing/ambiguous client or brand variants return `403`, including no later meta query. | PASS |
| PORTAL-2 | Every result is filtered by authenticated tenant, client, and brand; browser IDs are ignored. | Shared SQL predicate is all three conditions at `src/routes/cliente_insights.js:90-95`; PGlite test `test/cliente_portal_revisado.pglite.test.js:63-71` asserts the exact linked brand has only two eligible lives and `marca A` output. The profile request supplies hostile IDs and still asserts the authenticated record at `test/cliente_portal_perfil.test.js:30-38`. | PASS |
| PORTAL-3 | A live must be ended, reviewed/published, active, non-archived, non-absorbed, and have no undone union, consistently. | `reviewedLiveWhereSql` composes `officialEndedLiveSql` plus only `revisado`/`publicado` at `src/routes/cliente_insights.js:90-95` and is reused by home/history/daily at `:209`, `:282`, `:300`, `:351`. PGlite result assertion is `test/cliente_portal_revisado.pglite.test.js:63-71`. | PASS |
| PORTAL-4 | Only the permitted client DTO is returned; no presenter/internal/financial fields. | History maps an explicit DTO at `src/routes/cliente_insights.js:306-311`; `test/cliente_portal_revisado.pglite.test.js:74-86` asserts the exact allowed key set. Profile selects/maps only explicit own fields at `src/routes/cliente_portal.js:163-179`, asserted at `test/cliente_portal_perfil.test.js:30-38`. | PASS |
| PORTAL-5 | Unauthorized client routes are 403 before handlers; login/refresh/logout/password flows remain usable; invalid sessions remain denied. | Template allowlist and guard are `src/plugins/auth.js:19-27` and `:279-317`. `test/cliente_portal_access.test.js:56-86` asserts allowed requests reach handler and every blocked request returns exact 403 without handler execution; actual legacy PDF is checked at `:90-100`; invalid/revoked/missing-sub sessions assert 401/503 and no handler at `:101-142`. Refresh is intentionally unauthenticated at `src/routes/auth.js:94-195`. | PASS |
| PORTAL-6 | Stable 50-item page, offset validation, and full-period total/summary in São Paulo dates. | Query uses fixed `LIMIT 50`, stable `ORDER BY`, and distinct full-period summary at `src/routes/cliente_insights.js:273-323`; PGlite asserts `total: 53`, `limit: 50`, `offset: 50`, full summary and 3-item final page at `test/cliente_portal_revisado.pglite.test.js:89-105`. | PASS |
| PORTAL-7 | Preserve unknown as null and real zero as zero; no duration/ratio invention; empty values total zero. | Nullable conversions and safe duration are `src/routes/cliente_insights.js:66-87`; outcome logic is `:230-256` and `:306-323`. `test/cliente_portal_revisado.pglite.test.js:107-123` asserts unknown values/ratios remain null while measured zero remains zero. Meta zero/null behavior is asserted at `test/cliente_portal_perfil.test.js:56-66`. | PASS |
| PORTAL-8 | Private no-store responses, cache scope by user and tenant, and no prior-account display. | Auth response policy is `src/plugins/auth.js:292-294`; frontend account scope keys are `react-app/src/services/query-keys.ts:40-52`; stale-account render removal is asserted at `react-app/src/pages/ClienteConteudoPage.test.tsx:21-32`; backend headers are asserted at `test/cliente_portal_access.test.js:65-67` and `:83-86`. | PASS |
| PORTAL-9 | Only Results, Lives, and My Account; mobile works; empty/error distinct; own password change. | Client-only menu is `react-app/src/utils/access.ts:264-267`; client router is `react-app/src/routes/AppRouter.tsx:77-84`; user-visible desktop/mobile and password assertions are `react-app/tests/cliente-portal/cliente-portal.e2e.ts:119-198`. | PASS |
| PORTAL-10 | Two brands in a tenant and another tenant are proven with PGlite/mocks; full gates and independent review pass. | PGlite boundary test begins `test/cliente_portal_revisado.pglite.test.js:62-86`; allowlist/session mocks are `test/cliente_portal_access.test.js:56-149`; current full backend gate and independent sensor are recorded below. | PASS |

## Security and correctness review

- The client route boundary uses Fastify's registered route template, not a client-supplied path, at `src/plugins/auth.js:279-283`.
- Client context requires a unique user-to-client link and unique `tipo = 'cliente'` brand under the token tenant at `src/lib/cliente_resolver.js:38-65`.
- Client history/home/daily share the same restrictive predicate. The predicate has exact tenant, client, and brand IDs before eligibility constraints at `src/routes/cliente_insights.js:90-95`.
- Existing public ranking remains a separate product surface. A `cliente_parceiro` is redirected before an arbitrary authenticated outlet renders at `react-app/src/routes/ProtectedRoute.tsx:16-30`; the browser test proves `/ranking?unidade=...` causes no `/public/ranking` request at `react-app/tests/cliente-portal/cliente-portal.e2e.ts:132-137`.
- The diff adds no migrations, packages, secrets, deployment configuration, or index/cache artifacts. `git diff --check` was clean.

## Gate check

- **Command**: `npm test -- --maxWorkers=4`
- **Result**: 225 test files passed, 2,169 tests passed, 0 failed, 74 skipped; duration 225.77s.
- **Retry note**: the first sandboxed attempt failed only because `test/cli_livelab.test.js` was denied loopback binding (`EPERM 127.0.0.1`). The same local command was retried with loopback permission and passed. This is distinct from the earlier pre-verification PGlite startup timeout noted by the implementer.
- **Skip integrity**: 74 skips match the pre-feature baseline. The feature adds the actual legacy-PDF regression test and raised the reported passing-test count from 2,168 to 2,169; no test file was deleted in the diff.
- **Frontend cross-repository gate**: exact frontend HEAD passed typecheck, 132 files / 971 tests / 0 skips, production build, and 4 synthetic Playwright desktop/mobile tests / 0 skips. Logs are under `/Users/lucas/livelab-analysis/local-sync-20261021-093618/portal-frontend-final-*.log`.

## Discrimination sensor

All mutations were applied to disposable `git archive HEAD` copies with installed `node_modules` symlinked in. They were never applied to either real worktree.

| # | Mutation | Target | Focused check | Result |
| --- | --- | --- | --- | --- |
| 1 | Remove exact tenant predicate | `src/routes/cliente_insights.js:91` | `test/cliente_portal_revisado.pglite.test.js` | Killed |
| 2 | Admit `rascunho` as eligible | `src/routes/cliente_insights.js:95` | `test/cliente_portal_revisado.pglite.test.js` | Killed |
| 3 | Remove exact brand predicate | `src/routes/cliente_insights.js:93` | `test/cliente_portal_revisado.pglite.test.js` | Killed |
| 4 | Bypass frontend protected-route boundary | `react-app/src/routes/ProtectedRoute.tsx:18` | `ProtectedRoute.test.tsx` | Killed |
| 5 | Remove user/tenant cache scope from home key | `react-app/src/services/query-keys.ts:50` | `query-keys.test.ts` | Killed |
| 6 | Render unknown account meta as `R$ 0,00` | `react-app/src/pages/ConfiguracoesPage.tsx:28-30` | `ConfiguracoesPage.cliente.test.ts` | Killed |

**Sensor result**: 6 injected, 6 killed, 0 survived. The scratch directories were removed. A post-cleanup `git status --porcelain=v1` was empty for both real worktrees before this report was added.

## Code quality and scope

| Check | Result |
| --- | --- |
| Minimum code and surgical scope | PASS. New shared resolver, predicate, route gate, client DTOs, and focused UI are direct requirements. |
| No unsupported business rule | PASS. No account creation, migration, financial/ranking/export feature, or production action was added. |
| Test integrity | PASS. No skipped/deleted test was used to obtain green; added assertions target exact statuses, DTO keys, quantities, and headers. |
| Existing patterns | PASS. Fastify preHandlers, tenant transactions, React Query key factories, and existing password endpoint are reused. |
| Documented guidelines | PASS. Reviewed against `/Users/lucas/.agents/skills/tlc-spec-driven/references/coding-principles.md`. |

## Validation: PASS

**PASS.** The implementation meets PORTAL-1 through PORTAL-10. No fix task or lesson is required because no acceptance gap, spec-precision gap, or surviving mutation was found.
