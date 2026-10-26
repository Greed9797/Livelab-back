# Contributing — LiveShop SaaS Backend

Estado operacional atual: [STATUS.md](STATUS.md) e [registro de produção](docs/production-release-2026-10-26.md).

## Branch model

- `codex/blumenau-operational-fase1` — branch conectada à produção Railway na verificação de 26/10/2026. Push nela inicia deploy; siga as autorizações e a revisão descritas em `AGENTS.md`.
- Confira o SHA de `/health` e a referência remota antes de escolher a base. `master` não deve ser presumida como a versão publicada; o estado de branch protection não foi auditado nesta entrega.
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

1. Criar branch a partir do SHA atual da produção ou da branch remota confirmada; preservar trabalho local não publicado.
2. Commits seguindo Conventional Commits
3. Push + abrir PR via `gh pr create`
4. CI roda automaticamente (`backend-ci.yml`):
   - `npm ci`
   - `node --check src/**/*.js`
   - Testes e coverage, preparação do schema e fixtures SQL isoladas, conforme `.github/workflows/backend-ci.yml`. A contagem varia com a suíte; consulte o resultado datado em `STATUS.md`.
   - `npm audit --audit-level=high`
5. PR precisa: 1 review + CI verde + sem conflitos
6. Integrar na branch de destino revisada; qualquer atualização da branch conectada à Railway inicia publicação. Confira os filtros de push/PR do workflow antes de presumir que o CI será executado.
7. Tag se release: `git tag -a vX.Y.Z -m "release notes"`

## Antes de abrir PR

```bash
npx vitest run                    # não fixar a contagem histórica como critério
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
- Usar o executor e o ledger transacional existentes para aplicar somente migrações pendentes; usar `IF NOT EXISTS` e `ON CONFLICT` quando apropriado. Não presumir que qualquer SQL isolado seja reaplicável manualmente.
- Testar antes em banco local descartável com `node apply_migrations.js`; conferir o destino antes de executar. Para produção, seguir o fluxo autorizado de deploy e migração de `AGENTS.md`.

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
