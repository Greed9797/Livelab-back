# bot-tag-e-cli Validation — PASS ✅ (com 6 gaps menores, nenhum bloqueante)

**Date**: 2026-09-03
**Spec**: `.specs/features/bot-tag-e-cli/spec.md`
**Diff range**:
- Backend `~/liveshop_saas_api-backend-` (branch `codex/blumenau-operational-fase1`): `06e2e81^..21afdaa` (13 commits, 06e2e81..21afdaa)
- Front `~/dev/Livelab-Front` (branch `feat/multi-apresentadora-agenda`): `68691ff..8c99e89` (6 commits, 5ccfab5..8c99e89)
**Verifier**: sub-agente independente (autor ≠ verificador). Cobertura derivada só de evidência `file:line` + asserção; sem evidência = não coberto.

---

## Task Completion

| Task | Status | Notes |
|---|---|---|
| T1 migration 140 | ✅ Done | `migrations/140_origem_dados_bot.sql:12-38`; registrada em `apply_migrations.js:137` (coberto por `test/migrations_runner.test.js:50`). O `psql BEGIN…ROLLBACK` em prod declarado no Done-when **não pôde ser verificado** por mim (sem acesso ao banco nesta validação). |
| T2 helper + allowlist | ✅ Done | `src/plugins/auth.js:28,53-55` |
| T3 lives.js | ✅ Done | `src/routes/lives.js:671,781,935,1230,1345-1361,2577,2627` |
| T4 marcas.js | ✅ Done | `src/routes/marcas.js:24,235,278-288` + `src/services/client-brand.js:15,62-73` |
| T5 apresentadoras.js | ⚠️ SPEC_DEVIATION | `src/routes/apresentadoras.js:44` (COLS) e `:302-305` (comentário SPEC_DEVIATION). POST responde 410 (`:307`). Ver julgamento abaixo. |
| T6 analytics.js | ✅ Done | `src/routes/analytics.js:334-345,436,442-461,538,745,891,964` |
| T7 CLI | ✅ Done | `cli/livelab.py` (299 linhas, só stdlib `:19-27`) |
| T8 comandos nomeados | ✅ Done | `cli/livelab.py:189-232` |
| T9 doc | ✅ Done | `docs/api-automacao.md:45,136-175,177-205` |
| T10 BotBadge | ✅ Done | `react-app/src/components/ui/BotBadge.tsx:8-18`, `models.ts:165` |
| T11 lives lista/detalhe | ✅ Done | `LivesTab.tsx:1161`, `LiveDetailModal.tsx:81,100` |
| T12 histórico GMV | ✅ Done | `HistoricoGmvModal.tsx:48` |
| T13 marcas | ✅ Done | `ComercialPage.tsx:745` |
| T14 apresentadoras | ⚠️ SPEC_DEVIATION | `ApresentadorasPage.tsx:6-8` é só `<Navigate to="/configuracoes?tab=apresentadoras">`. Ver julgamento abaixo. |
| T15 lotes import | ✅ Done (parcial por desenho) | `AnalyticsImportSection.tsx:350` — só o lote aberto; o front não tem lista de lotes. `visual-check` marcado pendente no tasks.md e **não executado** nesta validação. |
| T16 modal edição | ✅ Done | `EditarLiveModal.tsx:519` |

### Julgamento das duas SPEC_DEVIATION declaradas

1. **BOT-02 / P1 AC2 (apresentadoras por chave = 'bot')** — `src/routes/apresentadoras.js:302-307`: a rota `POST /v1/apresentadoras` devolve **410 para qualquer papel** (comportamento pré-existente, não introduzido pela feature); apresentadora nasce do convite em `/v1/usuarios`, que está fora da allowlist por desenho (`test/api_key_auth.test.js:70`). Não existe caminho de escrita para marcar. **Bem justificada.** Efeito colateral a limpar: a allowlist ainda carrega `['POST', '/v1/apresentadoras']` (`src/plugins/auth.js:33`) — entrada morta que a CLI corretamente omite (`cli/livelab.py:52-53`). Ver Gap 4.
2. **T14 (chip em apresentadoras no front)** — `react-app/src/pages/ApresentadorasPage.tsx:6-8` redireciona para a aba de Configurações, que lista **usuários**; e pelo item 1 não pode existir apresentadora com `origem_dados='bot'`. Nada a renderizar. **Bem justificada** e coerente com a deviation 1.

---

## Spec-Anchored Acceptance Criteria

Legenda: ✅ PASS (asserção mira o valor da spec) · ⚠️ Spec-precision gap / parcial · ❌ GAP (sem evidência de teste).

### P1: Tudo que a chave cria nasce com `origem_dados = 'bot'`

| # | Criterion | Spec-defined outcome | `file:line` + asserção | Result |
|---|---|---|---|---|
| AC1 | POST /v1/marcas por chave | INSERT com 'bot', 201 | `test/marcas_origem_bot.test.js:37-39` — `expect(res.statusCode).toBe(201)`; `expect(insertMarcasArgs(query)).toContain('bot')`; `.not.toContain('manual')` | ✅ PASS |
| AC2 | POST /v1/apresentadoras por chave | 'bot' | Rota é 410 para todos (`src/routes/apresentadoras.js:307`). SPEC_DEVIATION declarada em `:302-305`. Sem teste de escrita (não há escrita). | ⚠️ SPEC_DEVIATION (justificada) |
| AC3 | POST /v1/lives/manual por chave, body 'manual' | 'bot' | `test/lives_manual.test.js:701,704-707` — payload `origem_dados: 'manual'`; `expect(res.statusCode).toBe(201)`; `expect(insertLivesArgs(queryMock)).toContain('bot')`; `.not.toContain('manual')` | ✅ PASS |
| AC4 | POST /v1/lives (iniciar) por chave | 'bot' | Nenhum teste com `viaApiKey` em POST /v1/lives. Só o caminho JWT: `test/lives_start.test.js:69,131` — `toEqual([..., marcaId, 'manual'])`. Código: `src/routes/lives.js:660,671` (`$9` = `origemDados(request)`); helper coberto em `test/api_key_auth.test.js:79`. | ⚠️ parcial — helper + JWT testados; caminho chave→'bot' na rota iniciar sem teste (Gap 2) |
| AC5 | ingest `criar_lives=true` por chave cria live | 'bot' | `test/analytics_import_ingest.test.js:250-252` — `expect(insertLives(queryMock)).toBeTruthy()`; `expect(insertLives(queryMock)[1]).toContain('bot')` | ✅ PASS |
| AC6 | ingest/preview por chave grava lote | 'bot' | ingest: `test/analytics_import_ingest.test.js:200-202` — `expect(insertLote(queryMock)[0]).toContain('origem_dados')`; `[1]).toContain('bot')`. preview: sem teste de rota; mesma função `criarLoteDeImportacao` com `origem: origemDados(request)` (`src/routes/analytics.js:745`); allowlist testada em `test/api_key_auth.test.js:57`. | ✅ PASS (ingest) / ⚠️ preview só por inspeção |
| AC7 | PATCH por chave altera ads_gmv ou status_publicacao → revisão | 'bot' na revisão | ads_gmv: `test/lives_manual.test.js:763-765` — `expect(revisao[0]).toContain('origem_dados')`; `expect(revisao[1]).toContain('bot')`; `toContain('750')`. status_publicacao: a revisão desse campo só existe na rota `/v1/lives/:id/publicar` (`src/routes/lives.js:2577-2578`), que a chave **não alcança** (`test/api_key_auth.test.js:62` — sub-rota de PATCH é false). | ✅ PASS (ads_gmv) / ⚠️ Spec-precision gap: metade "status_publicacao" do AC é inalcançável por chave |
| AC8 | PATCH por chave em registro 'manual' | mantém 'manual' (SQL sem origem_dados) | `test/lives_manual.test.js:744-747` — `expect(update[0]).not.toContain('origem_dados')`; `expect(update[1]).toContain('publicado')` | ✅ PASS |
| AC9 | mesmas rotas com JWT | 'manual' | lives/manual: `test/lives_manual.test.js:717-719` (`toContain('manual')`, `.not.toContain('bot')`); marcas: `test/marcas_origem_bot.test.js:48-50`; lote: `test/analytics_import_ingest.test.js:212-214`; live do lote manual: `:262-264` (`toContain('api')`); iniciar: `test/lives_start.test.js:69,131`, `test/routes.regressions.test.js:541`; helper: `test/api_key_auth.test.js:84-86` | ✅ PASS |
| AC10 | GETs devolvem origem_dados | campo presente | marcas: `test/marcas_origem_bot.test.js:61` — `expect(listagem[0]).toContain('m.origem_dados')`; apresentadoras: `test/apresentadoras_permissions.test.js:141-142` — `toContain('origem_dados')`, `expect(res.json()[0].origem_dados).toBe('bot')`; historico-gmv: `test/lives_manual.test.js:776-777` — `toContain('r.origem_dados')`, `expect(res.json().historico[0].origem_dados).toBe('bot')`; GET /v1/lives e /:id: coluna pré-existente, `src/routes/lives.js:1529,1855` (fora do diff, sem teste novo); GET /v1/analytics/imports: SQL `b.origem_dados` em `src/routes/analytics.js:964`, **sem teste**; GET /:id usa `SELECT b.*` (`:985`). | ⚠️ parcial — 3/5 com teste; imports list e lives só por inspeção (Gap 3) |
| AC11 | INSERT fora de ('manual','api','bot') | CHECK rejeita | `migrations/140_origem_dados_bot.sql:13-14,19-20,25-26,31-32,37-38` (CHECK nas 5 tabelas). Matriz de cobertura define "none / build gate only"; registro no runner coberto por `test/migrations_runner.test.js:50` — `expect(MIGRATIONS_LIST).toEqual(filesFrom016)`. Sem teste executando SQL. | ⚠️ verificado por inspeção (por desenho da matriz) |

### P1: `POST /v1/lives/manual` liberado para a chave

| # | Criterion | Spec-defined outcome | `file:line` + asserção | Result |
|---|---|---|---|---|
| AC1 | chave válida → mesmo status/body que produtor_live | 201 com `id`; 400 na validação | 201: `test/lives_manual.test.js:704-705` — `expect(res.statusCode).toBe(201)`; `expect(res.json().id).toBe(liveId)`. Papel `automacao` em `gestorRoleAccess`: `src/routes/lives.js:781`. 400 por chave: **sem teste** (400 só testado com JWT nos testes pré-existentes). | ✅ 201 / ⚠️ 400 por chave sem teste |
| AC2 | chave em `/v1/lives/manual/qualquer-coisa` | 403 | `test/api_key_auth.test.js:64-65` — `expect(chaveAlcancaRota('POST', '/v1/lives/manual/<uuid>')).toBe(false)`; `('POST', '/v1/lives/manual/x')).toBe(false)` (unit do matcher; o 403 em si é do plugin já testado em 854d920) | ✅ PASS |
| AC3 | `chaveAlcancaRota('POST','/v1/lives/manual')` | true | `test/api_key_auth.test.js:63` — `.toBe(true)` | ✅ PASS |

### P1: CLI `livelab` em Python 3

| # | Criterion | Spec-defined outcome | `file:line` + asserção | Result |
|---|---|---|---|---|
| AC1 | arquivo único, só stdlib | roda com `python3 cli/livelab.py` | `cli/livelab.py:19-27` (imports: argparse, base64, json, os, socket, sys, urllib.*); `test/cli_livelab.test.js:11,39` executa o arquivo real via `execFile('python3', [CLI, ...])`; `python3 -m py_compile` rc=0 | ✅ PASS |
| AC2 | sem LIVELAB_API_KEY | stderr `LIVELAB_API_KEY não definida`, exit 2 | `test/cli_livelab.test.js:50-52` — `expect(r.status).toBe(2)`; `expect(r.stderr).toContain('LIVELAB_API_KEY não definida')`; `expect(recebidas).toHaveLength(0)` | ✅ PASS |
| AC3 | `api GET /v1/lives -q` | query montada, X-API-Key, body em stdout, exit 0 | `:57-60` — `toBe(0)`; `expect(ultima().url).toBe('/v1/lives?data_inicio=2026-09-01&status=encerrada')`; `expect(ultima().headers['x-api-key']).toBe(CHAVE)`; `expect(JSON.parse(r.stdout)).toEqual({...})` | ✅ PASS |
| AC4 | `api POST -d` | application/json + resposta | `:65-68` — `expect(ultima().headers['content-type']).toBe('application/json')`; `expect(ultima().body).toEqual({ nome: 'Marca X', tipo: 'afiliada' })` | ✅ PASS |
| AC5 | `-f corpo.json` | body lido do arquivo | `:75-78` — `expect(ultima().body).toEqual({ observacoes: 'via cli' })` (usa PATCH; mesmo `ler_body`) | ✅ PASS |
| AC6 | `ingest` campos + `--preview` | `{filename,content_base64,marca_id,apresentadora_id,criar_lives}` → ingest; preview troca rota | `:94-97` — `toBe('/v1/analytics/imports/ingest')`; `filename).toBe('relatorio.csv')`; base64 decodifica para o CSV; `toMatchObject({ marca_id, apresentadora_id, criar_lives: true })`; `:101-103` — `toBe('/v1/analytics/imports/preview')` | ✅ PASS |
| AC7 | arquivo > 5 MB | recusa antes, stderr, exit 2 | `:108-112` — 5 MB + 1 byte; `expect(r.status).toBe(2)`; `expect(r.stderr).toContain('teto')`; `expect(recebidas).toHaveLength(0)` | ✅ PASS |
| AC8 | status fora de 2xx | stderr `{"status","error"}`, exit 1 | `:117-119` — `toBe(1)`; `expect(r.stdout).toBe('')`; `expect(JSON.parse(r.stderr.trim())).toEqual({ status: 500, error: { error: 'boom' } })` | ✅ PASS |
| AC9 | 403 | linha `rota não liberada para chave de API — veja: livelab rotas` | `:124-127` — `expect(linha2).toBe('rota não liberada para chave de API — veja: livelab rotas')` | ✅ PASS |
| AC10 | erro de rede/DNS/timeout 60 s | exit 3 | `:131-133` — porta fechada; `expect(r.status).toBe(3)`; `expect(r.stderr).toContain('erro de rede')`. Timeout 60 s: `cli/livelab.py:31,100` por inspeção (não testado — testar levaria 60 s). | ✅ PASS (rede) / ⚠️ timeout só por inspeção |
| AC11 | `livelab rotas` | tabela **idêntica** à allowlist | `:139-145` — `expect(r.stdout).toMatch(/^POST\s+\/v1\/lives\/manual\s/m)`; `linhas.length >= 10`; cada linha `expect(chaveAlcancaRota(metodo, rota)).toBe(true)`. Só verifica CLI ⊆ allowlist; a volta (allowlist ⊆ CLI) não é verificada. De fato a tabela **não é idêntica**: `cli/livelab.py:39-55` omite `POST /v1/apresentadoras` (entrada morta, 410) e expande `GET /v1/analytics/` só em `imports` (esconde `/dashboard`, `/funil`, `/diario`, `/franqueado/resumo`, que a chave alcança por prefixo — `src/plugins/auth.js:24,43`). | ⚠️ Spec-precision gap (Gap 1) |
| AC12 | nunca imprime a chave | ausente em stdout/stderr | `:153-155` — para ok e recusado com `--verbose`: `expect(saida).not.toContain(CHAVE)` | ✅ PASS |
| AC13 | `--verbose` | método, URL, status em stderr | `:151` — `expect(ok.stderr).toContain(\`GET ${base}/v1/lives -> 200\`)` | ✅ PASS |
| AC14 | `--help` | lista comandos e campos | `:160-164` — geral contém api/ingest/rotas; `ingest --help` contém as 4 flags; `:190-194` — `marcas --help` contém nome/tipo/cliente_id/comissao_franquia_pct; `lives --help` contém `/v1/lives/manual`, hora_inicio, fat_gerado, ads_gmv | ✅ PASS |

### P2: Chip BOT no painel React

Matriz de cobertura definiu "none (typecheck)" para páginas/modais; só `BotBadge` tem unit. Resultados abaixo são inspeção + typecheck, exceto AC5.

| # | Criterion | Spec-defined outcome | `file:line` + asserção | Result |
|---|---|---|---|---|
| AC1 | live 'bot' na lista/detalhe | `<Badge tone="sistema">BOT</Badge>` | `BotBadge.tsx:15-17` (`<Badge tone="sistema">BOT</Badge>`); `BotBadge.test.tsx:8-9` — `expect(html).toContain('BOT')`; montagem: `LivesTab.tsx:1161`, `LiveDetailModal.tsx:81`. `tsc -b` rc=0. | ✅ componente / ⚠️ páginas só typecheck |
| AC2 | revisão 'bot' no HistoricoGmvModal | "Alterado por" = `BOT` | `HistoricoGmvModal.tsx:48` — `isBot(item.origem_dados) ? 'BOT' : asString(item.alterado_por_nome ?? ...)`; sem teste de render | ⚠️ inspeção |
| AC3 | marca/apresentadora 'bot' na lista | chip na linha | marcas: `ComercialPage.tsx:745`; apresentadoras: SPEC_DEVIATION T14 (`ApresentadorasPage.tsx:6-8`) | ⚠️ inspeção / deviation justificada |
| AC4 | lote 'bot' em AnalyticsPage | chip na linha | `AnalyticsImportSection.tsx:350` — `<BotBadge origem={batch?.origem_dados} />` no lote aberto (não há lista de lotes no front; `batch` vem de GET `/v1/analytics/imports/:id` que faz `SELECT b.*`, `analytics.js:985`) | ⚠️ inspeção, parcial por desenho |
| AC5 | manual/api/ausente | sem chip | `BotBadge.test.tsx:13-15` — `it.each([['manual'],['api'],[undefined],[null],['']])`: `expect(renderToStaticMarkup(<BotBadge origem={origem} />)).toBe('')`; `expect(isBot(origem)).toBe(false)` | ✅ PASS |

### P2: Comandos nomeados e doc

| # | Criterion | Spec-defined outcome | `file:line` + asserção | Result |
|---|---|---|---|---|
| AC1 | nomeados traduzem e delegam | rota correspondente | `test/cli_livelab.test.js:170` — `toMatchObject({ method: 'POST', url: '/v1/lives/manual', ... })`; `:174` — `PATCH /v1/marcas/<id>`; `:178` — `GET /v1/lives?status=encerrada`; `:182` — `GET /v1/analytics/imports/<id>`; `:185-186` — `get` sem id → exit 2 `precisa do id`. `apresentadoras`/`comissoes` não exercitados, mas passam pelo mesmo `cmd_nomeado` (`cli/livelab.py:224-232`). | ✅ PASS |
| AC2 | `-d`/`-f` sem transformar | body igual | `:170,174` — `body: { cabine_id: 'x', data: '2026-09-01' }`, `body: { status: 'pausada' }` | ✅ PASS |
| AC3 | doc | lives/manual, origem_dados bot, seção CLI com `curl -O` | `docs/api-automacao.md:45` (tabela), `:136-140` (exemplo), `:168-175` (origem_dados = "bot"), `:177-205` (seção CLI, `curl -fsSLO`, exemplos) | ✅ PASS (inspeção; matriz = none) |

**Status**: ✅ Todos os ACs com resultado preciso e alcançável têm asserção que mira o valor da spec, ou deviation justificada. ⚠️ 6 gaps menores listados abaixo.

---

## Edge Cases

- [ ] **Chave com `criado_por` preenchido → mesmo assim 'bot'**: `src/plugins/auth.js:54` lê só `request.viaApiKey`; testes de rota setam `sub: null` quando há chave (`test/lives_manual.test.js:26`, `test/marcas_origem_bot.test.js:16`). **Sem teste com `sub` preenchido + `viaApiKey`** (Gap 5).
- [x] **Body `origem_dados: 'api'` por chave → 'bot'**: `test/api_key_auth.test.js:81` — `expect(origemDados({ viaApiKey: { id: 'k' } }, 'api')).toBe('bot')` (nível helper; a rota passa `d.origem_dados` em `lives.js:935`).
- [ ] **Migration em banco com `lives_origem_dados_check` já existente**: `migrations/140_origem_dados_bot.sql:12` (`DROP CONSTRAINT IF EXISTS`). Sem teste automatizado (matriz = build gate). O `psql BEGIN…ROLLBACK` do T1 não pôde ser verificado por mim.
- [ ] **Revisão antiga sem origem_dados → 'manual'**: `migrations/140_origem_dados_bot.sql:29` (`NOT NULL DEFAULT 'manual'` — ADD COLUMN preenche linhas existentes). Sem teste; depende do banco.
- [x] **Rota sem `/v1` → prefixa**: `test/cli_livelab.test.js:82-84` — `expect(ultima().url).toBe('/v1/lives')`; código `cli/livelab.py:74-80`.

---

## Gate Check

| Repo | Comando | Resultado |
|---|---|---|
| Backend | `python3 -m py_compile cli/livelab.py` | rc=0 |
| Backend | `npx vitest run` | **751 passed, 0 failed, 7 skipped** (758 total; 105 arquivos passed, 1 skipped) |
| Backend (baseline, worktree em `06e2e81^` = 854d920) | `npx vitest run` | **721 passed, 0 failed, 7 skipped** — confirmado empiricamente |
| Front | `npm run typecheck` (`tsc -b`) | rc=0 |
| Front | `npx vitest run` | **299 passed, 0 failed** |

- **Delta backend**: +30 testes (721 → 751). Nenhum teste removido; contagem não caiu.
- **Skipped (7)**: todos em `test/rls_isolation.test.js` (describe inteiro pulado: exige banco real com role `NOBYPASSRLS`). Pré-existentes — mesmos 7 no baseline. Justificado.
- **Asserções enfraquecidas**: nenhuma. `test/lives_start.test.js:69,131` e `test/routes.regressions.test.js:541` ficaram **mais** específicas (array exato ganhou `'manual'`). `test/api_key_auth.test.js:63` inverteu de `false` para `true` por mudança de requisito (MAN-01), com os dois negativos novos em `:64-65`.

---

## Discrimination Sensor

Executado em worktrees descartáveis (`git worktree add … HEAD`), nunca no tree real; sem `git stash`. Baseline `git status --porcelain` capturado antes: backend 4 entradas pré-existentes (` M .gitignore`, `?? .ignore`, `?? CLAUDE.md`, `?? cli/__pycache__/`), front vazio. Após `git worktree remove --force` + `prune`: **diff do porcelain vazio nos dois repos** — isolamento provado.

| # | Mutação | Arquivo:linha (HEAD) | Teste(s) rodado(s) | Resultado |
|---|---|---|---|---|
| 1 | `origemDados`: `'bot'` → `'manual'` | `src/plugins/auth.js:54` | api_key_auth, lives_manual, marcas_origem_bot, analytics_import_ingest | ✅ Killed — 5 falhas (`api_key_auth:79`, `lives_manual:706`, `lives_manual:764`, `marcas_origem_bot:38`, `analytics_import_ingest:202`) |
| 2 | remove `['POST', '/v1/lives/manual']` da allowlist | `src/plugins/auth.js:28` | api_key_auth, cli_livelab | ✅ Killed — 2 falhas (`api_key_auth:63`, `cli_livelab:136` "rotas lista…") |
| 3 | PATCH sem `&& !request.viaApiKey` | `src/routes/lives.js:1230` | lives_manual | ✅ Killed — 1 falha (`lives_manual:746` — SQL passou a conter `origem_dados`) |
| 4 | `resolveTargetLive`: `batch.origem_dados === 'bot' ? 'bot' : 'api'` → `'api'` | `src/routes/analytics.js:345` | analytics_import_ingest | ✅ Killed — 1 falha (`:252`) |
| 5 | (front) `isBot`: `origem === 'bot'` → `!== 'bot'` | `react-app/src/components/ui/BotBadge.tsx:9` | BotBadge.test.tsx | ✅ Killed — 6/6 falhas |
| 6 | rota ingest sem `origem: origemDados(request)` (side effect removido) | `src/routes/analytics.js:891` | analytics_import_ingest | ✅ Killed — 1 falha (`:202`). (Primeira tentativa por número de linha errado não aplicou — `git diff --stat` vazio — e foi descartada; refeita com a linha certa.) |
| 7 | CLI sem a dica do 403 (`status == 403` → `40399`) | `cli/livelab.py:125` | cli_livelab | ✅ Killed — 1 falha (`:127`) |

**Sensor depth**: P0-full (auth é caminho crítico) — 7 mutações, 3 delas no plugin auth / gate do PATCH.
**Result**: **7/7 killed** — PASS ✅. Nenhum sobrevivente.

---

## Code Quality

| Check | Status | Nota |
|---|---|---|
| No features beyond what was asked | ✅ | Extras pequenos e coerentes: `ORIGEM_LABEL` em `LiveDetailModal.tsx:13,100` (rótulo humano de origem) e `alterado_por_nome` em `HistoricoGmvModal.tsx:48` (corrige campo que o backend já devolvia e o front não lia). Aceitáveis. |
| No abstractions for single-use code | ✅ | `origemDados` é usado em 11 pontos (lives, marcas, analytics, client-brand); `isBot` em 2. |
| No unnecessary flexibility | ✅ | `origem = 'manual'` como default em `client-brand.js:15` e `analytics.js:436` mantém chamadores antigos intactos. |
| Only touched files required for task | ✅ | Todos os 21 arquivos do backend e 9 do front estão no design ou são consequência direta (`client-brand.js` para a marca-espelho de cliente; `apply_migrations.js` para registrar a 140). `src/plugins/auth.js:22` trocou `POST /v1/analytics/imports` (rota inexistente — `analytics.js` só tem `/preview:678` e `/ingest:786`) por `/preview` — correção necessária para o AC6 e coberta em `test/api_key_auth.test.js:57`. |
| Didn't "improve" unrelated code | ✅ | — |
| Matches existing patterns/style | ✅ | Testes seguem o `buildApp` + `queryMock` dos vizinhos (`test/marca_obrigatoria.test.js`, `test/lives_manual.test.js`); `BotBadge.test.tsx:5` usa `renderToStaticMarkup` como os outros de `ui/`. |
| Would senior engineer approve? | ✅ | Sim, com as limpezas do Gap 4 (allowlist morta) e Gap 1 (espelho da CLI). |
| Tests map to ACs and are non-shallow (spot-check P1 tag BOT) | ✅ | `lives_manual:692-708` testa o caso adversarial (body 'manual' + chave → 'bot' e **não** 'manual'). Asserções `toContain` no array de params são position-agnostic, mas o par `toContain('bot')`/`not.toContain('manual')` fecha a porta; o sensor confirmou (MUT1/3/4/6). |
| Spec-anchored outcome check | ⚠️ | Ver ACs marcados ⚠️: CLI AC11 ("idêntica"), BOT AC7 (status_publicacao), AC10 (imports list). |
| Per-layer Coverage Expectation met | ⚠️ | Rotas: happy + adversarial cobertos; **error path por chave** (400 em lives/manual) não; POST /v1/lives iniciar por chave sem teste. Plugin auth 1:1 ✅. CLI 1:1 ✅. |
| Every test in scope maps to spec AC / edge / Done-when | ✅ | Todos os 30 testes novos mapeiam (tabela acima). |
| Documented guidelines followed | ✅ | `~/.claude/rules/common.md` (AAA, nomes descritivos) — seguido; `package.json` `vitest run` — seguido. |

Observação de higiene (não é do diff): `cli/__pycache__/` aparece como untracked no tree real (gerado por `py_compile`; já estava no baseline). Vale um `cli/__pycache__/` no `.gitignore` — o `.gitignore` tem modificação local não commitada que não inspecionei.

---

## Ranked Gaps (nenhum bloqueante)

| # | Gap | AC | Evidência | Fix task sugerida | Prioridade |
|---|---|---|---|---|---|
| 1 | `livelab rotas` não é "idêntica" à allowlist e o teste só checa CLI ⊆ allowlist | CLI AC11 | `cli/livelab.py:39-55` vs `src/plugins/auth.js:21-36`; `test/cli_livelab.test.js:139-145` | Ou (a) relaxar a spec para "toda linha da CLI é alcançável pela chave, e toda rota concreta da allowlist aparece" e adicionar no teste a volta: para cada `[m, rota]` de `ROTAS_API_KEY` (exportando-a ou lendo o arquivo) exigir uma linha na saída — tratando prefixos `GET /v1/analytics/` e a entrada morta; ou (b) gerar `ROTAS` a partir de um JSON exportado pelo backend. Recomendo (a). | Minor |
| 2 | `POST /v1/lives` (iniciar) por chave não tem teste que grava 'bot' | BOT AC4 | `src/routes/lives.js:660,671` só coberto no caminho JWT (`test/lives_start.test.js:69,131`) | Em `test/lives_start.test.js`, duplicar o caso "cliente" com `viaApiKey` no decorator e `toEqual([..., marcaId, 'bot'])`. | Minor |
| 3 | `GET /v1/analytics/imports` devolve `b.origem_dados` sem teste; `POST …/preview` por chave sem teste de rota | BOT AC10, AC6 | `src/routes/analytics.js:964,745`; `test/analytics_import_routes.test.js` não menciona `origem_dados` | Adicionar em `analytics_import_routes.test.js`: GET list com row `{origem_dados:'bot'}` → `res.json()[0].origem_dados === 'bot'` e SQL contém `b.origem_dados`; e um `preview` com `viaApiKey` → INSERT do lote contém `'bot'`. | Minor |
| 4 | Entrada morta `['POST', '/v1/apresentadoras']` na allowlist (rota é 410) | BOT AC2 (deviation) | `src/plugins/auth.js:33`; `src/routes/apresentadoras.js:307` | Remover a linha da allowlist e adicionar `expect(chaveAlcancaRota('POST','/v1/apresentadoras')).toBe(false)` em `test/api_key_auth.test.js`; atualizar spec AC2 para "GET devolve o campo; POST é 410". | Minor (higiene/segurança por construção) |
| 5 | Edge "chave com `criado_por` preenchido" sem teste | Edge 1 | `src/plugins/auth.js:54`; mocks setam `sub: null` | Em `test/marcas_origem_bot.test.js`, variante com `sub: 'user-1'` **e** `viaApiKey` → params contêm `'bot'`. | Minor |
| 6 | Error path por chave (400 de validação em `POST /v1/lives/manual`) sem teste; `visual-check` do T15 pendente | MAN AC1; P2 AC1/AC4 | `test/lives_manual.test.js` só testa 400 com JWT; `tasks.md` T15 marca visual-check pendente | Um caso `viaApiKey` + payload inválido → 400; rodar `visual-check` na lista de lives com uma live bot (precisa de ambiente com dado bot). | Minor |

Spec-precision gaps (para ajustar a spec, não o código): BOT AC7 — "status_publicacao" só gera revisão em `/v1/lives/:id/publicar`, fora do alcance da chave; reescrever o AC como "ads_gmv, fat_gerado ou manual_gmv". CLI AC10 — timeout de 60 s verificado só por inspeção (`cli/livelab.py:31,100`).

---

## Requirement Traceability Update

| Requirement | Previous | New |
|---|---|---|
| BOT-01 | Done | ✅ Verified (`marcas_origem_bot.test.js:37-39`) |
| BOT-02 | SPEC_DEVIATION | ✅ Verified as deviation (justificada; Gap 4 para limpar allowlist) |
| BOT-03 | Done | ✅ Verified (manual) / ⚠️ iniciar por chave sem teste (Gap 2) |
| BOT-04 | Done | ✅ Verified (`analytics_import_ingest.test.js:250-252`) |
| BOT-05 | Done | ✅ Verified (`:200-202`) |
| BOT-06 | Done | ✅ Verified (`lives_manual.test.js:763-765`) |
| BOT-07 | Done | ✅ Verified |
| BOT-08 | Done | ✅ Verified (`lives_manual.test.js:746`; MUT3 killed) |
| BOT-09 | Done | ⚠️ Verified parcial (Gap 3) |
| BOT-10 | Done | ⚠️ Inspeção (migration; sem teste por desenho) |
| MAN-01 | Done | ✅ Verified (`api_key_auth.test.js:63-65`, `lives_manual.test.js:704-705`) |
| CLI-01..06 | Done | ✅ Verified (`cli_livelab.test.js:48-165`) — CLI-06 com ⚠️ AC11 (Gap 1) |
| UI-01..03 | Done | ⚠️ Typecheck + inspeção (matriz = none); UI-03 apresentadoras = deviation justificada |
| UI-04 | Done | ✅ Verified (`BotBadge.test.tsx:13-15`; MUT5 killed) |
| CLI-07 | Done | ✅ Verified (`cli_livelab.test.js:167-195`) |
| DOC-01 | Done | ✅ Verified por inspeção (`docs/api-automacao.md:45,136-205`) |

---

## Summary

**Overall**: ✅ Ready (com 6 fix tasks menores opcionais)

**Spec-anchored check**: 31/36 ACs com asserção mirando o valor da spec ou deviation justificada; 5 ⚠️ (CLI AC11, BOT AC4, BOT AC7-metade, BOT AC10-parcial, MAN AC1-400) — nenhum é falha de comportamento observada, todos são cobertura/precisão.
**Sensor**: 7/7 mutações mortas (P0-full, 3 no auth).
**Gate**: backend 751 passed / 0 failed / 7 skipped (baseline 721 confirmado em worktree); front typecheck rc=0 + 299 passed / 0 failed.

**What works**: tag 'bot' forçada por `viaApiKey` em marcas, lives manual, live do ingest, lote, revisão de GMV; PATCH por chave não reescreve origem; JWT continua 'manual'; allowlist exata para `/v1/lives/manual`; CLI completa (exit codes 0/1/2/3, 5 MB, 403 dica, `--verbose` sem vazar chave, nomeados); chip BOT no React só para `'bot'`.

**Issues found**: ver Ranked Gaps (todos Minor).

**Next steps**: rodar as fix tasks 1–5 como uma única tarefa de testes (sem mudança de comportamento, exceto Gap 4 que remove uma linha da allowlist); ajustar a spec nos dois pontos de precisão; executar o `visual-check` pendente do T15 quando houver um registro bot em ambiente de teste.
