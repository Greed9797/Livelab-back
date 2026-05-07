# Contributing — LiveShop SaaS Backend

## Branch model

- `master` — produção. Push direto bloqueado (branch protection ativa).
- `feat/<descricao>` — nova feature
- `fix/<descricao>` — bugfix
- `sec/<descricao>` — security fix
- `chore/<descricao>` — refactor, docs, deps, infra

## Commits — Conventional Commits

```
<tipo>[escopo]: descrição curta

[corpo opcional explicando "porquê"]

[trailers]
Co-Authored-By: <Nome> <email>
```

Tipos: `feat`, `fix`, `sec`, `docs`, `chore`, `refactor`, `test`, `perf`, `revert`.

Exemplos:
- `feat(financeiro): adicionar pill de período Trimestre`
- `sec: hotfix RLS leak em /v1/cabines (defesa em profundidade)`
- `fix(analytics): cap delta em ±999% para período sem histórico`
- `chore(deps): bump @sentry/node de 9.x para 10.x`

## PR workflow

1. Criar branch a partir de `master`
2. Commits seguindo Conventional Commits
3. Push + abrir PR via `gh pr create`
4. CI roda automaticamente (`backend-ci.yml`):
   - `npm ci`
   - `node --check src/**/*.js`
   - `npx vitest run` (62 testes esperado)
   - `npm audit --audit-level=high`
5. PR precisa: 1 review + CI verde + sem conflitos
6. Merge via "Squash and merge" (mantém histórico linear em `master`)
7. Tag se release: `git tag -a vX.Y.Z -m "release notes"`

## Antes de abrir PR

```bash
npx vitest run                    # 62/62 esperado
node --check src/**/*.js          # sem erros sintaxe
node scripts/audit-rls.js         # sem drift RLS
```

## Regras de código

- **Nova rota** em `src/routes/<feature>.js` — registrar em `src/app.js`
- **RLS**: TODA query em tabela multi-tenant DEVE ter `WHERE tenant_id = $1::uuid`
  ou `current_setting('app.tenant_id')::uuid` explícito (role Postgres atual
  bypassa RLS — ver Runbook em `README.md`)
- **Auth**: `preHandler: [app.authenticate, app.requirePapel(['gerente'])]`
- **Validação**: Zod `safeParse` → `reply.code(400)` em erro
- **Erros**: nunca expor stack/PII em response 500 — só log interno
- **Testes**: cobertura mínima por rota nova (1 happy path + 1 erro)

## Migrations

- **Append-only** — nunca renomear/editar uma já aplicada
- Adicionar à `MIGRATIONS_LIST` em `apply_migrations.js`
- Idempotente (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`)
- Test local antes: `node apply_migrations.js`

## Nunca commitar

- Arquivos `.env`
- Logs (`*.log`)
- `node_modules/`
- Screenshots com PII
- DSN/secrets/tokens em código

## PR template

`.github/pull_request_template.md` é carregado automaticamente.

## Hotfix workflow (urgente prod)

1. `git checkout -b fix/<descricao>`
2. Fix + commit
3. PR + tag de prioridade `urgent`
4. Reviewer aprova rápido (skip review se security-blocker confirmado por tech lead)
5. Merge → Railway auto-deploy (~1min)
6. Validar via `/health` + smoke test
7. Tag `vX.Y.Z+1` se mudança visível
