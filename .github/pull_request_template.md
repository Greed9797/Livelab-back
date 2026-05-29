## Summary

<!-- 1-3 bullets do que muda e porquê -->

## Changes

<!-- Lista arquivos críticos modificados -->
- `src/routes/...`
- `migrations/...`

## Tipo

- [ ] feat (nova funcionalidade)
- [ ] fix (bugfix)
- [ ] sec (security)
- [ ] docs
- [ ] chore (refactor / deps / infra)
- [ ] test
- [ ] perf

## Test plan

- [ ] `npx vitest run` — 62/62 passa
- [ ] `node --check src/**/*.js` — sem erros sintaxe
- [ ] Manual: testei localmente em `npm run dev`
- [ ] Migration aplicada em local (`node apply_migrations.js`)
- [ ] `node scripts/audit-rls.js` — sem drift
- [ ] Smoke test em prod após merge (Railway auto-deploy)

## Checklist

- [ ] Conventional Commits no histórico
- [ ] RLS: queries multi-tenant têm `WHERE tenant_id` explícito
- [ ] Sem PII em logs / response 500
- [ ] `.env.example` atualizado se nova var
- [ ] README/CONTRIBUTING atualizados se mudança arquitetural
- [ ] Tag de release planejada se quebra de contrato

## Security

<!-- Tem implicação de segurança? Se sim, descrever -->

## Rollback plan

<!-- Como reverter se quebrar prod -->
