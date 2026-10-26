# Production release record — October 26, 2026

This record describes the deployed backend state verified on October 26, 2026.
It is the current production reference for this repository.

## Backend deployment

| Item | Verified value |
| --- | --- |
| Railway project | `kind-rebirth` (`4f8b8b0c-75e3-4e85-b146-e3d08315639c`) |
| Environment | `80826e92-5369-4475-a70c-49526df114dc` |
| Service | `liveshop-saas-api` (`b9ff608f-baf6-464e-bbe8-a7d29bf653f5`) |
| Public API | `https://liveshop-saas-api-production.up.railway.app` |
| Deployed backend commit | `894e903b57610b8a38431b3a1e220ecbe4499089` |
| Deployment | `4bd1f6ef-0b73-4c71-b307-17a51331da35` — `SUCCESS` |
| Deployment source branch | `codex/blumenau-operational-fase1` |
| Previous deployment | `82793ab1-b590-4e88-bcf6-84ecceea7d95`, commit `9d0e02c` |

The current working branch does not identify the code running in production.
Use the deployed commit above when checking production contracts.

## Database and readiness

Migration `186_training_video.sql` was applied by the deployment's
transactional migration runner before the application started. The effective
Railway database migration ledger records migration 186 as applied, with no
pending migration at verification time. The existing training catalog data
was present after deployment: one trail and five lessons.

Both `/health` and `/readyz` returned HTTP 200. Readiness reported healthy
storage. No Railway environment variables, credentials, or infrastructure
settings were changed as part of this release verification.

## Release checks

- Backend CI run `40413286251` succeeded: 2,200 passed, 67 skipped; 230 files
  passed and 13 were skipped. The coverage gate and isolated SQL fixtures passed. Production dependency
  audit reported zero vulnerabilities.
- Focused backend checks passed 50 of 50 cases across six files, including
  CRM workflow tests and PGlite training integration for tenant boundaries
  and watched intervals.
- The frontend release published commit
  `3eae78bfa269dc610f7e2028031e139a1b980597` as version
  `1793054319509`. Its CI run `40413624195` passed with 1,034 tests across
  142 files, type checks, build, and deployment.

The checks above are CI and API readiness evidence. They do not establish a
visual, authenticated production smoke test for master and franchisee users.

## Rollback boundary

The previous backend binary is commit `9d0e02c` from deployment
`82793ab1-b590-4e88-bcf6-84ecceea7d95`. Keep migration 186 and its data in
place during any application rollback. The previous binary predates the
`direct_video` training source and cannot serve lessons using that source;
rolling back the binary therefore does not restore full compatibility for
those lessons. Do not treat database rollback or deletion of migration data
as part of the binary rollback.

## MCP status

This release did not configure MCP environment variables or validate an
OAuth connection. The older instructions in
[`HANDOFF-MCP-RAILWAY.md`](HANDOFF-MCP-RAILWAY.md) describe a historical,
unfinished handoff; they are not evidence that MCP is currently enabled.

## Related API contracts

- [CRM API](crm-api.md)
- [Training module](training-module.md)
