# Tag BOT + CLI — Design

**Spec**: `spec.md` · **Escopo**: Large (2 repos, 15 tarefas)

## Decisões

| ID | Decisão | Por quê |
|---|---|---|
| D1 | Uma coluna `origem_dados TEXT NOT NULL DEFAULT 'manual' CHECK IN ('manual','api','bot')` em `marcas`, `apresentadoras`, `live_metric_revisions`, `analytics_import_batches`; em `lives` só a CHECK ganha `'bot'` | Mesmo nome que já existe em `lives` e no tipo `LiveAtual` do React; sem tabela nova, sem join |
| D2 | Helper `origemDados(request, doBody = 'manual')` em `src/plugins/auth.js`: `request.viaApiKey ? 'bot' : doBody` | Um ponto de verdade; toda rota de escrita chama isso no INSERT |
| D3 | PATCH nunca grava `origem_dados` vindo de chave (`lives.js:1227` ganha `&& !request.viaApiKey`) | BOT-08: origem é fixada na criação |
| D4 | `['POST', '/v1/lives/manual']` na `ROTAS_API_KEY`; `AUTOMACAO` entra em `gestorRoleAccess` (`lives.js:777`) | Matcher POST sem barra é exato: `/v1/lives/manual/x` continua 403 |
| D5 | CLI = `cli/livelab.py`, Python 3.8+, só stdlib. Subcomandos: `api`, `ingest`, `rotas`, mais açúcar `lives/marcas/apresentadoras/comissoes/imports` que só montam método+rota e delegam a `api` | "API geral": `api` cobre qualquer rota liberada sem código novo por rota |
| D6 | React: `BotBadge({ origem })` em `components/ui/BotBadge.tsx` devolve `<Badge tone="sistema">BOT</Badge>` só quando `origem === 'bot'` | Reuso de `Badge`; regra "sem chip para manual/api" num lugar só |

## Backend — pontos de mudança

| Arquivo | Mudança |
|---|---|
| `migrations/140_origem_dados_bot.sql` | `ALTER TABLE lives DROP CONSTRAINT IF EXISTS lives_origem_dados_check; ADD CONSTRAINT ... CHECK (origem_dados IN ('manual','api','bot'))`; `ADD COLUMN IF NOT EXISTS origem_dados` + CHECK nas 4 tabelas |
| `src/plugins/auth.js` | `export function origemDados(request, doBody='manual')`; allowlist ganha `POST /v1/lives/manual` |
| `src/routes/lives.js` | import `AUTOMACAO` em `gestorRoleAccess`; INSERT iniciar (`:655`, hoje literal `'manual'`) e manual (`:933`, `d.origem_dados`) passam `origemDados(request, d.origem_dados)`; 4 INSERTs de `live_metric_revisions` (`:1342,:1349,:1356,:2574`) ganham coluna `origem_dados`; PATCH `:1227` ignora campo quando `viaApiKey`; `historico-gmv` (`:2623`) devolve `r.origem_dados` |
| `src/routes/marcas.js` | INSERT `:272` ganha `origem_dados`; `marcaCols` (`:18`) ganha `m.origem_dados` |
| `src/routes/apresentadoras.js` | INSERT `:80` ganha `origem_dados` (a rota `:302` chama esse helper — passar a origem); `COLS` (`:43`) ganha `origem_dados` |
| `src/routes/analytics.js` | `criarLoteDeImportacao` (`:431`) recebe `origem` e grava no INSERT `:436`; `resolveTargetLive` (`:289`) recebe `origem` e troca o literal `'api'` (`:330`) por parâmetro; rotas `ingest`/`preview` passam `origemDados(request)`; GET `/v1/analytics/imports` (`:947`) devolve `b.origem_dados` |

Mock de teste: os testes de rota existentes decoram `authenticate` e setam `request.user`;
para simular chave basta `request.viaApiKey = { id, nome }` no mesmo decorator
(`test/marca_obrigatoria.test.js:11`, `test/lives_manual.test.js:20`). Asserção: o array
de parâmetros do `queryMock` contém `'bot'` na posição da coluna.

## CLI — `cli/livelab.py`

```
livelab [--verbose] api <GET|POST|PATCH> <rota> [-q k=v ...] [-d JSON | -f arquivo.json]
livelab ingest <arquivo> [--marca-id U] [--apresentadora-id U] [--criar-lives] [--preview]
livelab rotas
livelab lives list|get <id>|criar|editar <id>      (criar = POST /v1/lives/manual)
livelab marcas list|criar|editar <id>
livelab apresentadoras list|criar|editar <id>
livelab comissoes list
livelab imports get <id>
```

- Env: `LIVELAB_API_KEY` (obrigatória, exit 2 se faltar), `LIVELAB_API_URL` (default prod).
- `urllib.request` com `timeout=60`; `URLError`/`socket.timeout` → exit 3.
- Não-2xx → stderr `{"status", "error"}` exit 1; 403 acrescenta dica `livelab rotas`.
- `ingest`: lê bytes, recusa > 5 MB (exit 2), monta JSON `{filename, content_base64, marca_id?, apresentadora_id?, criar_lives?}`.
- Rota sem `/v1/` na frente ganha o prefixo.
- A chave só vai no header; `--verbose` imprime `METHOD URL -> status`.
- `rotas` imprime tabela fixa espelhando `ROTAS_API_KEY` (mantida à mão; o teste compara com a allowlist exportada).

Teste `test/cli_livelab.test.js`: sobe Fastify em porta livre que ecoa método, headers e
body; roda `python3 cli/livelab.py` com `child_process.spawnSync` e `env` apontando para
ele; cobre CLI-02..CLI-06. Pula com `it.skip` se `python3` não existir no PATH.

## React — `~/dev/Livelab-Front/react-app` (repo separado, commits próprios)

| Arquivo | Mudança |
|---|---|
| `src/types/models.ts:165` | `origem_dados: 'manual' \| 'api' \| 'bot'` |
| `src/components/ui/BotBadge.tsx` (novo) | D6 + teste `BotBadge.test.tsx` (bot renderiza, manual/api/undefined não) |
| `src/components/conteudo/*` (lista de lives) + `LiveDetailModal.tsx` | `<BotBadge origem={live.origem_dados} />` ao lado do status |
| `src/components/forms/EditarLiveModal.tsx:516` | `<select>` ganha `<option value="bot" disabled>Bot</option>` para não perder o valor ao editar |
| `src/pages/HistoricoGmvModal.tsx:47` | render: `origem_dados === 'bot' ? 'BOT' : nome` |
| `src/pages/ComercialPage.tsx` (tabela `ativos`) | `BotBadge` na célula do nome |
| `src/pages/ApresentadorasPage.tsx` | idem |
| `src/pages/AnalyticsPage.tsx` (lista de lotes) | idem |

## Fora do design (confirmado na spec)

Sem tag em edição de registro humano; sem Flutter; sem DELETE; sem persistência de chave
pela CLI.
