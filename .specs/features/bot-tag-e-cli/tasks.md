# Tag BOT + CLI Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/bot-tag-e-cli/design.md`
**Status**: In Progress

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `~/.claude/rules/common.md` (80% em código novo, AAA), `package.json` (`vitest run test/*.test.js`), `react-app/package.json` (`vitest run`, `tsc -b`).

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Rotas Fastify (lives, marcas, apresentadoras, analytics) | integration (Fastify inject + queryMock) | 1:1 com BOT-01..09 e MAN-01: chave grava 'bot', JWT grava 'manual', PATCH não reescreve, sub-rota 403 | `test/*.test.js` | `npx vitest run test/<arquivo>.test.js` |
| Plugin auth (matcher, helper) | unit | `chaveAlcancaRota` para `/v1/lives/manual` true e `/v1/lives/manual/x` false; `origemDados` com e sem `viaApiKey` | `test/api_key_auth.test.js` | `npx vitest run test/api_key_auth.test.js` |
| CLI Python | integration (spawn `python3` contra Fastify falso) | CLI-02..CLI-06 + edge "rota sem /v1" | `test/cli_livelab.test.js` | `npx vitest run test/cli_livelab.test.js` |
| Migration SQL | none | build gate + `psql` `BEGIN…ROLLBACK` em prod na verificação | `migrations/*.sql` | build gate only |
| React componente `BotBadge` | unit (vitest + testing-library) | bot renderiza; manual/api/undefined não (UI-04) | `react-app/src/**/*.test.tsx` | `cd react-app && npx vitest run` |
| React páginas/modais | none (typecheck) | `tsc -b` limpo + visual-check | `react-app/src/pages/**` | `cd react-app && npm run typecheck` |
| Docs | none | — | `docs/api-automacao.md` | build gate only |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | tarefa com teste unitário/integração de um arquivo | `npx vitest run test/<arquivo>.test.js` |
| Full | tarefa que toca rota + auth | `npx vitest run` (721 passando hoje) |
| Build | fim de fase | backend: `node --check` nos arquivos tocados + `npx vitest run`; react: `cd ~/dev/Livelab-Front/react-app && npm run typecheck && npx vitest run` |

---

## Execution Plan

### Phase 1: Banco e auth

```
T1 → T2
```

### Phase 2: Rotas backend

```
T2 → T3
T2 → T4
T2 → T5
T2 → T6
```

### Phase 3: CLI e doc

```
T2 → T7 → T8 → T9
```

### Phase 4: React

```
T10 → T11
T10 → T12
T10 → T13
T10 → T14
T10 → T15
T10 → T16
```

---

## Task Breakdown

### T1: Migration origem_dados com 'bot' ✅ DONE

**What**: `migrations/140_origem_dados_bot.sql` — recria a CHECK de `lives` com `'bot'` e adiciona `origem_dados TEXT NOT NULL DEFAULT 'manual'` + CHECK em `marcas`, `apresentadoras`, `live_metric_revisions`, `analytics_import_batches`, tudo idempotente.
**Where**: `migrations/140_origem_dados_bot.sql`
**Depends on**: None
**Reuses**: padrão de `migrations/081_cabines_lives_restructure.sql:56`
**Requirement**: BOT-10
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] `DROP CONSTRAINT IF EXISTS lives_origem_dados_check` + `ADD CONSTRAINT` com os 3 valores
- [x] 4 `ADD COLUMN IF NOT EXISTS` com DEFAULT e CHECK
- [x] `psql` em prod: `BEGIN; \i migration; INSERT marca origem 'bot'; INSERT origem 'x' falha; ROLLBACK` sem erro além do esperado
**Tests**: none
**Gate**: build
**Commit**: `feat(db): origem_dados aceita 'bot' em lives, marcas, apresentadoras, revisões e lotes`

---

### T2: Helper origemDados + allowlist lives/manual ✅ DONE

**What**: `export function origemDados(request, doBody = 'manual')` e `['POST', '/v1/lives/manual']` em `ROTAS_API_KEY`; testes do matcher e do helper.
**Where**: `src/plugins/auth.js`
**Depends on**: T1
**Reuses**: `chaveAlcancaRota`, `test/api_key_auth.test.js`
**Requirement**: MAN-01, BOT-07
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] `chaveAlcancaRota('POST','/v1/lives/manual') === true`; `/v1/lives/manual/x === false`
- [x] `origemDados({viaApiKey:{}}) === 'bot'`; `origemDados({}) === 'manual'`; `origemDados({}, 'api') === 'api'`; `origemDados({viaApiKey:{}}, 'manual') === 'bot'`
- [x] Gate check passes: `npx vitest run test/api_key_auth.test.js` (7 testes)
**Tests**: unit
**Gate**: quick
**Commit**: `feat(auth): helper origemDados e POST /v1/lives/manual liberado para chave`

---

### T3: lives.js grava origem bot e expõe no histórico ✅ DONE

**What**: `AUTOMACAO` em `gestorRoleAccess`; INSERT iniciar e manual usam `origemDados(request, d.origem_dados)`; 4 INSERTs de `live_metric_revisions` ganham `origem_dados`; PATCH ignora `origem_dados` quando `viaApiKey`; `historico-gmv` devolve `r.origem_dados`.
**Where**: `src/routes/lives.js`
**Depends on**: T2
**Reuses**: `origemDados` (T2), `test/lives_manual.test.js` buildApp
**Requirement**: BOT-03, BOT-06, BOT-08, BOT-09, MAN-01
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Teste: `POST /v1/lives/manual` com `papel:'automacao'` + `viaApiKey` → 201 e params do INSERT contêm `'bot'` mesmo com body `origem_dados:'manual'`
- [x] Teste: mesmo POST com `papel:'franqueado'` sem chave → `'manual'`
- [x] Teste: `PATCH /v1/lives/:id` com chave e `origem_dados:'manual'` no body → SQL gerado não contém `origem_dados`
- [x] Teste: PATCH `ads_gmv` com chave → INSERT de revisão com `'bot'`
- [x] Gate check passes: `npx vitest run test/lives_manual.test.js test/api_key_auth.test.js`
**Tests**: integration
**Gate**: full
**Commit**: `feat(lives): origem_dados='bot' em live e revisão criadas por chave de API`

---

### T4: marcas.js grava e devolve origem ✅ DONE

**What**: INSERT de marca ganha `origem_dados` via `origemDados(request)`; `marcaCols` ganha `m.origem_dados`.
**Where**: `src/routes/marcas.js`
**Depends on**: T2
**Reuses**: `test/marca_obrigatoria.test.js` buildApp
**Requirement**: BOT-01, BOT-09
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Teste: POST com `viaApiKey` → params do INSERT contêm `'bot'`; sem chave → `'manual'`
- [x] Teste: GET `/v1/marcas` SQL contém `m.origem_dados`
- [x] Gate check passes: `npx vitest run test/marca_obrigatoria.test.js`
**Tests**: integration
**Gate**: quick
**Commit**: `feat(marcas): origem_dados='bot' quando criada por chave de API`

---

### T5: apresentadoras.js grava e devolve origem ✅ DONE

**What**: INSERT (`:80`) ganha `origem_dados` passado pela rota POST; `COLS` ganha `origem_dados`.
**Where**: `src/routes/apresentadoras.js`
**Depends on**: T2
**Reuses**: `test/apresentadoras_permissions.test.js` buildApp
**Requirement**: BOT-02, BOT-09
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] SPEC_DEVIATION: POST /v1/apresentadoras responde 410 para todo mundo (cadastro só via convite de usuário) — não há escrita por chave para marcar
- [x] Teste: GET SQL contém `origem_dados` e a resposta devolve o campo
- [x] Gate check passes: `npx vitest run test/apresentadoras_permissions.test.js`
**Tests**: integration
**Gate**: quick
**Commit**: `feat(apresentadoras): origem_dados='bot' quando criada por chave de API`

---

### T6: analytics.js — lote e live do ingest com origem ✅ DONE

**What**: `criarLoteDeImportacao` e `resolveTargetLive` recebem `origem`; `ingest`/`preview` passam `origemDados(request)`; literal `'api'` da live criada vira o parâmetro; GET `/v1/analytics/imports` devolve `b.origem_dados`.
**Where**: `src/routes/analytics.js`
**Depends on**: T2
**Reuses**: `test/analytics_import_ingest.test.js`, `test/analytics_import_routes.test.js`
**Requirement**: BOT-04, BOT-05, BOT-09
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Teste: `ingest` com `viaApiKey` → INSERT do lote contém `'bot'`; sem chave → `'manual'`
- [x] Teste: `ingest` com `criar_lives=true` e chave → INSERT em `lives` contém `'bot'`; sem chave mantém `'api'`
- [x] Gate check passes: `npx vitest run test/analytics_import_ingest.test.js test/analytics_import_routes.test.js`
**Tests**: integration
**Gate**: full
**Commit**: `feat(analytics): origem_dados='bot' em lote e live criados pelo ingest por chave`

---

### T7: CLI livelab.py — api, ingest, rotas, erros ✅ DONE

**What**: `cli/livelab.py` só stdlib com subcomandos `api`, `ingest`, `rotas`, flags `--verbose`, env `LIVELAB_API_KEY`/`LIVELAB_API_URL`, exit codes 0/1/2/3, dica no 403, teto 5 MB, prefixo `/v1`.
**Where**: `cli/livelab.py`
**Depends on**: T2
**Reuses**: contrato de `docs/api-automacao.md`
**Requirement**: CLI-01, CLI-02, CLI-03, CLI-04, CLI-05, CLI-06
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] `test/cli_livelab.test.js` sobe Fastify falso e cobre: chave ausente exit 2; `api GET -q` monta query e header; `api POST -d` e `-f`; `ingest` manda base64 + campos, `--preview` troca a rota, >5 MB exit 2; 403 imprime dica; não-2xx exit 1; porta fechada exit 3; `rotas` lista `POST /v1/lives/manual`; `--verbose` não contém a chave
- [x] `python3 -m py_compile cli/livelab.py`
- [x] Gate check passes: `npx vitest run test/cli_livelab.test.js`
**Tests**: integration
**Gate**: quick
**Commit**: `feat(cli): livelab.py para o Grok bot chamar a API pelo terminal`

---

### T8: CLI — comandos nomeados ✅ DONE

**What**: subcomandos `lives list|get|criar|editar`, `marcas list|criar|editar`, `apresentadoras list|criar|editar`, `comissoes list`, `imports get` que montam método+rota e delegam ao caminho de `api`; `--help` por comando com campos do body.
**Where**: `cli/livelab.py`
**Depends on**: T7
**Reuses**: T7
**Requirement**: CLI-07
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Teste: `lives criar -d {...}` bate em `POST /v1/lives/manual`; `marcas editar <id> -d` bate em `PATCH /v1/marcas/<id>`; `lives list -q` em `GET /v1/lives?...`
- [x] Gate check passes: `npx vitest run test/cli_livelab.test.js`
**Tests**: integration
**Gate**: quick
**Commit**: `feat(cli): comandos nomeados lives/marcas/apresentadoras/comissoes/imports`

---

### T9: Doc de automação ✅ DONE

**What**: `docs/api-automacao.md` ganha `POST /v1/lives/manual` na tabela e no exemplo, o campo `origem_dados = 'bot'`, e a seção "CLI" (download com `curl -O`, env, exemplos de cada comando, exit codes).
**Where**: `docs/api-automacao.md`
**Depends on**: T8
**Reuses**: doc existente
**Requirement**: DOC-01
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Tabela de rotas igual à `ROTAS_API_KEY`
- [x] Todo exemplo de CLI roda contra o Fastify falso do T7 (conferido à mão uma vez)
**Tests**: none
**Gate**: build
**Commit**: `docs(api): lives/manual, origem_dados bot e CLI livelab`

---

### T10: React — tipo e BotBadge ✅ DONE

**What**: `origem_dados` aceita `'bot'` em `LiveAtual`; novo `BotBadge({ origem })` + teste.
**Where**: `~/dev/Livelab-Front/react-app/src/components/ui/BotBadge.tsx`
**Depends on**: None
**Reuses**: `src/components/ui/Badge.tsx` (`tone="sistema"`)
**Requirement**: UI-04
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] `BotBadge.test.tsx`: `'bot'` renderiza texto `BOT`; `'manual'`, `'api'`, `undefined` renderizam nada
- [x] `src/types/models.ts:165` união com `'bot'`
- [x] Gate check passes: `cd ~/dev/Livelab-Front/react-app && npx vitest run src/components/ui`
**Tests**: unit
**Gate**: quick
**Commit**: `feat(ui): BotBadge para registros criados pela automação`

---

### T11: React — lives lista, detalhe e modal de edição ✅ DONE

**What**: `BotBadge` na linha da lista de lives e em `LiveDetailModal` (ambos em `conteudo/`).
**Where**: `~/dev/Livelab-Front/react-app/src/components/conteudo/`
**Depends on**: T10
**Reuses**: T10
**Requirement**: UI-01
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Live com `origem_dados:'bot'` mostra chip na lista e no detalhe
- [x] Gate check passes: `npm run typecheck && npx vitest run`
**Tests**: none
**Gate**: build
**Commit**: `feat(lives): chip BOT na lista e no detalhe`

---

### T12: React — histórico de GMV ✅ DONE

**What**: coluna "Alterado por" mostra `BOT` quando `origem_dados === 'bot'`.
**Where**: `~/dev/Livelab-Front/react-app/src/pages/HistoricoGmvModal.tsx`
**Depends on**: T10
**Reuses**: T10
**Requirement**: UI-02
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Render da coluna: bot → `BOT`; senão nome ou `—`
- [x] Gate check passes: `npm run typecheck`
**Tests**: none
**Gate**: build
**Commit**: `feat(gmv): histórico mostra BOT em revisão feita pela automação`

---

### T13: React — marcas ✅ DONE

**What**: `BotBadge` na célula do nome da tabela de ativos/marcas.
**Where**: `~/dev/Livelab-Front/react-app/src/pages/ComercialPage.tsx`
**Depends on**: T10
**Reuses**: T10
**Requirement**: UI-03
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Marca bot mostra chip
- [x] Gate check passes: `npm run typecheck`
**Tests**: none
**Gate**: build
**Commit**: `feat(marcas): chip BOT na lista`

---

### T14: React — apresentadoras ⛔ SPEC_DEVIATION

**What**: `BotBadge` na linha da lista.
**Where**: `~/dev/Livelab-Front/react-app/src/pages/ApresentadorasPage.tsx`
**Depends on**: T10
**Reuses**: T10
**Requirement**: UI-03
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] SPEC_DEVIATION: o front não lista a entidade `apresentadoras` (a aba de Configurações lista usuários) e a API não deixa a chave criar apresentadora (410) — não existe registro bot para marcar. Nada a renderizar.
- [ ] Apresentadora bot mostra chip
- [ ] Gate check passes: `npm run typecheck`
**Tests**: none
**Gate**: build
**Commit**: `feat(apresentadoras): chip BOT na lista`

---

### T15: React — lotes de import ✅ DONE

**What**: `BotBadge` na linha do lote na lista de importações.
**Where**: `~/dev/Livelab-Front/react-app/src/pages/AnalyticsPage.tsx`
**Depends on**: T10
**Reuses**: T10
**Requirement**: UI-03
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Lote bot mostra chip (AnalyticsImportSection: o front não tem lista de lotes, só o lote aberto)
- [ ] (pendente, ver validação) `visual-check` da lista de lives e de imports com um registro bot
- [x] Gate check passes: `npm run typecheck && npx vitest run`
**Tests**: none
**Gate**: build
**Commit**: `feat(analytics): chip BOT no lote de import`

---

### T16: React — modal de edição preserva origem bot ✅ DONE

**What**: `<select>` de `origem_dados` ganha `<option value="bot" disabled>Bot</option>` para a live bot não perder o valor ao ser editada.
**Where**: `~/dev/Livelab-Front/react-app/src/components/forms/EditarLiveModal.tsx`
**Depends on**: T10
**Reuses**: `setIfChanged` já existente no modal
**Requirement**: UI-01
**Tools**:
- MCP: NONE
- Skill: NONE
**Done when**:
- [x] Abrir live bot no modal mostra "Bot" selecionado
- [x] Salvar sem mexer em origem não envia `origem_dados` no PATCH
- [x] Gate check passes: `npm run typecheck`
**Tests**: none
**Gate**: build
**Commit**: `fix(lives): modal de edição não apaga origem bot`
