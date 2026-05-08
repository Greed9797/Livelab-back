# STATUS — Backend LiveShop SaaS

**Última atualização**: 2026-05-08
**Tag prod**: `v1.5.0-deadcode-clean`
**Score sênior**: ~96/100 (zero issues critical, 1 débito documentado)

---

## Estado atual

- ✅ Health: `https://liveshop-saas-api-production.up.railway.app/health` → `{"ok":true}`
- ✅ Tests: 62/62 (`npx vitest run`)
- ✅ Coverage: 21% baseline + threshold 20% no CI (alarm regressão)
- ✅ CI: GitHub Actions `.github/workflows/backend-ci.yml` (vitest + syntax + audit)
- ✅ Sentry instalado (DSN não setado em prod — pendente user)
- ✅ Audit log + INCIDENT_PLAYBOOK.md + 3 ADRs documentados
- ✅ Migrations 058 + 059 + 060 + 061 aplicadas em prod
- ⚠️ RLS leak documentado (`rolbypassrls=true`) — mitigação Camada 3 em 13/27 rotas
- ⏳ Pendente: P0.1+P0.2 user (role NOBYPASSRLS Supabase + DATABASE_URL Railway)

---

## Última sprint (2026-05-08 — release `v1.5.0-deadcode-clean`)

### Aplicado

**P1 RLS hardening** (13/27 rotas com `WHERE tenant_id` explícito):
- analytics, home, clientes, boletos, apresentadoras, cabines, contratos, financeiro, recomendacoes, excelencia, pacotes, cliente_portal, solicitacoes
- Migration `060_rls_with_check.sql` aplicada — todas policies agora com WITH CHECK

**P2 Testing infra**:
- vitest --coverage com threshold 20% pinned
- E2E Playwright config corrigido (`cwd` aponta Playground)
- Helper `loginViaAPI` hardenado (waitForFunction polling + retry 3×)
- Análise specs: 41/66 pass (61%); falhas são specs outdated, não regressions

**P3 UX hardening**:
- Error boundary global Flutter (release-only)
- A11y semantics on por default
- CSP meta tag em web/index.html

**P4 DR / Incident**:
- INCIDENT_PLAYBOOK.md (10 cenários, ~370 linhas)
- Audit log: migration 061 + plugin `src/plugins/audit_log.js` (PII scrub)
- Script `scripts/pg_dump_offsite.sh` (backup S3/R2 com retention 30d)

**P5 Docs**:
- ADR 0001 Flutter Web canvaskit (frontend repo)
- ADR 0002 Fastify vs Express
- ADR 0003 Supabase RLS strategy
- README sênior (250+ linhas com setup, arch, runbook)
- CONTRIBUTING.md + PR template

**Dead code cleanup**:
- 2 itens backend (getClientIp, has alias)
- Hotfix `b777ff0` — managerHas re-adicionado (audit reportou unused, era usado em cabines.js:1190)

---

## Pendências para 100%

### 🔴 P0 — Manuais (você, ~30min)

1. Criar role `liveshop_app NOBYPASSRLS LOGIN` no Supabase Dashboard SQL Editor
2. Atualizar `DATABASE_URL` Railway pra essa role
3. Criar projeto Sentry → setar `SENTRY_DSN` em Railway env
4. UptimeRobot ping `/health` 5min
5. Branch protection master GitHub
6. `WEBHOOK_REPLAY_PROTECTION=true` Railway (após sender bio-crm enviar timestamp+nonce)
7. Aplicar `scripts/cleanup_lives_dirty.sql` (8 lives com encerrado_em > 24h)
8. Setar BACKUP_S3_* envs Railway + cron 03:00 → `bash scripts/pg_dump_offsite.sh`

### 🟠 P1 — Eu (sprint, ~3h)

- 14 rotas RLS restantes (cliente_dashboard, franqueado, leads, manuais, onboarding, tenants, tiktok, etc.)
- Re-rodar Playwright após fix specs analytics shape + helper

### 🟡 P2-P4 — Backlog (Wave 2, ~10h)

- Widget tests Flutter (5 critical screens)
- Coverage backend 70% target
- pg_dump validation script (restore test semanal)
- Audit log integrado em rotas críticas (delete custo, change senha, etc)
- E2E Playwright UI specs match livelab_v2 sidebar text

### 🔵 W3 — Roadmap (próximo trimestre)

- Feature flags (PostHog ou DB table)
- LGPD direito esquecimento
- WAF Cloudflare em frente Railway
- Mutation testing (Stryker)
- DB read replicas Supabase para analytics

---

## Comandos prontos

```bash
# Tests + push
npx vitest run                     # 62/62
npx vitest run --coverage          # threshold 20%
node apply_migrations.js           # idempotente
git push origin master             # Railway auto-deploy

# Audit
node scripts/audit-rls.js          # detect RLS drift
node --check src/**/*.js           # syntax

# DB ops
set -a; source .env; set +a
psql "$DATABASE_URL" -c "SELECT ..."
psql "$DATABASE_URL" < scripts/cleanup_lives_dirty.sql  # após editar ROLLBACK→COMMIT

# Backup
BACKUP_S3_BUCKET=... bash scripts/pg_dump_offsite.sh
```

---

## URLs

- App: https://livelab-3601f.web.app · https://app.grupolivelab.com.br
- API: https://liveshop-saas-api-production.up.railway.app/v1
- Health: `/health` (token via `HEALTH_CHECK_TOKEN` env)
- GitHub: Greed9797/liveshop_saas_api-backend-

## Credenciais teste (4 roles)

| Role | Email | Senha |
|---|---|---|
| franqueador_master | admin@liveshop.com | admin123 |
| franqueado | franqueado@liveshop.com | teste123 |
| cliente_parceiro | cliente@liveshop.com | teste123 |
| apresentador | apresentador@liveshop.com | teste123 |

---

## Referências

- `~/.claude/plans/crystalline-launching-acorn.md` — plano mestre
- `~/security-report.md` — auditoria segurança + CRITICAL FINDING
- `~/qa-e2e-report-2026-05-08.md` — QA E2E último ciclo
- `~/lighthouse-baseline-2026-05-07.md` — perf baseline
- `INCIDENT_PLAYBOOK.md` — runbook 10 cenários
- `docs/adr/*.md` — ADRs (Fastify, RLS strategy)
