# Tag BOT em tudo que entra por chave de API + CLI do Grok bot — Specification

## Problem Statement

A chave de API (`X-API-Key`, criada em 854d920) já escreve em produção, mas nada no dado
gravado diz que foi o bot: `audit_log` guarda `via: api_key`, e só. Marca, apresentadora,
live, revisão de GMV e lote de import criados pelo Grok bot aparecem no painel iguais aos
que a Ana e o Wagner cadastram, e ninguém consegue separar o que a automação fez do que
uma pessoa fez sem abrir o audit_log. Além disso o bot não tem ferramenta para chamar a
API de dentro do terminal da VM: hoje o contrato existe só como `curl` no doc, e um agente
que monta `curl` à mão erra header, base64 e multipart.

## Goals

- [ ] Todo registro **criado** por chave de API sai da API com `origem_dados = 'bot'` e o
      painel React mostra chip **BOT** nele (lives, marcas, apresentadoras, revisão de
      GMV, lote de import).
- [ ] Um arquivo Python 3 sem dependência (`cli/livelab.py`) roda na VM do Grok bot e cobre
      toda rota liberada para a chave, com `ingest` de arquivo e saída JSON.
- [ ] `POST /v1/lives/manual` liberado para a chave, com a mesma tag.

## Out of Scope

| Feature | Reason |
|---|---|
| Marcar registro criado por pessoa que o bot editou depois | Decisão do Vitor: origem fixa na criação; a edição fica no histórico de GMV e no audit_log |
| Chip BOT no Flutter | Front em produção é o React (`react-app/`, branch `migration/react-vercel`); Flutter é legado |
| `DELETE` ou rotas de agenda, financeiro, usuários, configurações para a chave | Allowlist fechada por construção (auth.js); fora do pedido |
| Tag em `agenda_eventos` | Chave não alcança `/v1/agenda`; live criada pelo bot não gera evento de agenda |
| OpenAPI / SDK em outra linguagem | O bot consome texto + CLI; Python 3 foi a escolha |
| Persistir a chave em arquivo pela CLI | Chave só por variável de ambiente; arquivo em VM compartilhada vaza |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
|---|---|---|---|
| Resposta da UI marcou "lives", "histórico", "marcas/apresentadoras" **e** "só backend" | Entregar backend primeiro (P1) e os chips React nos três lugares (P2), na mesma feature | As três opções de tela foram marcadas; "só backend" lido como ordem, não exclusão | n |
| Mecanismo da tag | Reusar a coluna `lives.origem_dados` (já existe, CHECK manual/api) e adicionar `origem_dados` com o mesmo CHECK em `marcas`, `apresentadoras`, `live_metric_revisions`, `analytics_import_batches`; valor novo `'bot'` | Uma coluna com o mesmo nome em todas as tabelas; o front já tipa `origem_dados` em Live | y (design) |
| Valor `'api'` existente em lives | Mantido intocado (é o autostart da agenda, `src/jobs/agenda_autostart.js`) | Não é bot; mudar significado quebraria histórico | y |
| Origem decidida por quem chama, não pelo payload | Quando `request.viaApiKey` existe, `origem_dados` é forçado para `'bot'` e o campo do body é ignorado; sem chave, comportamento atual (`'manual'` por padrão) | Bot não pode se disfarçar de pessoa | y |
| Runtime da VM do Grok | Python 3.8+ só stdlib (`urllib`, `json`, `argparse`, `base64`) | Resposta do Vitor; sem pip na VM | y |
| Base URL padrão da CLI | `https://liveshop-saas-api-production.up.railway.app`, sobrescrevível por `LIVELAB_API_URL` | Mesmo valor do doc `docs/api-automacao.md` | y |
| Chip BOT no React | `Badge` existente (`react-app/src/components/ui/Badge.tsx`) com `tone="sistema"` e texto `BOT` | Reuso; tom "sistema" já existe para coisa não humana | y |
| Histórico de GMV | Coluna "Alterado por" mostra `BOT` quando `origem_dados = 'bot'`, senão o nome do usuário | Hoje `alterado_por` é NULL para a chave e a coluna mostra "—" | y |
| Papel `automacao` em `/v1/lives/manual` | Entra na lista `gestorRoleAccess` de `lives.js` e a rota entra na allowlist como POST exato | Decisão do Vitor: liberar manual (não o iniciar) | y |

**Open questions:** none - all resolved or logged above.

---

## Implicit-requirement dimensions

| Dimensão | Resolução |
|---|---|
| Input validation & bounds | `origem_dados` fica com CHECK `('manual','api','bot')` no banco; zod das rotas segue aceitando só `manual`/`api` no body (bot é forçado, não enviado). CLI: `ingest` recusa arquivo > 5 MB antes de mandar (teto de `src/app.js`) |
| Failure / partial-failure | Migration idempotente (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`); CLI devolve exit code distinto por classe de falha |
| Idempotency / retry | Já coberto por `file_hash` no ingest (854d920); CLI não faz retry sozinho — o bot decide |
| Auth boundaries & rate limits | Allowlist ganha só `POST /v1/lives/manual` exato; `/v1/lives/manual/...` continua 403; rate limit por chave inalterado |
| Concurrency / ordering | N/A because a tag é gravada no mesmo INSERT do registro; sem passo separado |
| Data lifecycle / expiry | N/A because a coluna vive com a linha; sem TTL |
| Observability | `audit_log` já marca `via: api_key`; tag no dado é a parte visível. CLI com `--verbose` imprime método, rota e status (nunca a chave) |
| External-dependency failure | CLI: timeout 60 s e exit 3 em erro de rede/DNS, mensagem curta em stderr |
| State-transition integrity | N/A because `origem_dados` não transita: é fixado na criação e nunca reescrito por PATCH (BOT-08) |

---

## User Stories

### P1: Tudo que a chave cria nasce com `origem_dados = 'bot'` ⭐ MVP

**User Story**: Como gestora da unidade, quero que todo registro criado pela automação
venha marcado como BOT, para separar o que o bot fez do que a equipe cadastrou.

**Why P1**: Sem a marca no dado, GMV e comissão do bot se misturam com os da equipe.

**Acceptance Criteria**:

1. WHEN `POST /v1/marcas` é chamado com `X-API-Key` válida THEN the system SHALL gravar a
   marca com `origem_dados = 'bot'` e devolvê-la com esse campo na resposta 201.
2. WHEN `POST /v1/apresentadoras` é chamado com chave válida THEN the system SHALL gravar
   a apresentadora com `origem_dados = 'bot'`.
3. WHEN `POST /v1/lives/manual` é chamado com chave válida THEN the system SHALL gravar a
   live com `origem_dados = 'bot'`, mesmo que o body traga `origem_dados: 'manual'`.
4. WHEN `POST /v1/lives` (iniciar) é chamado com chave válida THEN the system SHALL gravar
   a live com `origem_dados = 'bot'`.
5. WHEN `POST /v1/analytics/imports/ingest` com `criar_lives=true` cria uma live por chave
   THEN the system SHALL gravar essa live com `origem_dados = 'bot'`.
6. WHEN `POST /v1/analytics/imports/ingest` ou `/preview` é chamado por chave THEN the
   system SHALL gravar o lote em `analytics_import_batches` com `origem_dados = 'bot'`.
7. WHEN `PATCH /v1/lives/:id` por chave altera `ads_gmv` ou `status_publicacao` THEN the
   system SHALL gravar a linha de `live_metric_revisions` com `origem_dados = 'bot'`.
8. WHEN `PATCH` por chave atinge registro com `origem_dados = 'manual'` THEN the system
   SHALL manter `origem_dados = 'manual'` nesse registro.
9. WHEN as mesmas rotas são chamadas com JWT de usuário THEN the system SHALL gravar
   `origem_dados = 'manual'` por padrão (comportamento atual preservado).
10. The system SHALL devolver `origem_dados` em `GET /v1/marcas`, `GET /v1/apresentadoras`,
    `GET /v1/lives`, `GET /v1/lives/:id`, `GET /v1/lives/:id/historico-gmv` e
    `GET /v1/analytics/imports`.
11. IF um INSERT tentar `origem_dados` fora de `('manual','api','bot')` THEN the database
    SHALL rejeitar a linha pela constraint CHECK.

**Independent Test**: com a chave, `POST /v1/marcas` e depois `GET /v1/marcas`: a marca
nova vem com `origem_dados: "bot"`; a mesma chamada com JWT vem `"manual"`.

---

### P1: `POST /v1/lives/manual` liberado para a chave ⭐ MVP

**User Story**: Como Grok bot, quero cadastrar uma live já encerrada com data, hora, GMV e
pedidos, para alimentar comissão sem depender de planilha.

**Why P1**: `POST /v1/lives` só inicia live ao vivo em cabine; sem `manual` o bot não
cadastra live pronta.

**Acceptance Criteria**:

1. WHEN `POST /v1/lives/manual` chega com chave válida THEN the system SHALL responder
   com o mesmo status e body que responderia a um `produtor_live` (201 com `id` no
   sucesso, 400 na validação).
2. IF a chave chama `POST /v1/lives/manual/qualquer-coisa` THEN the system SHALL responder
   403.
3. `chaveAlcancaRota('POST', '/v1/lives/manual')` SHALL devolver `true`.

**Independent Test**: teste unitário de `chaveAlcancaRota` + teste de rota com
`papel: 'automacao'` e `viaApiKey` no request devolvendo 201.

---

### P1: CLI `livelab` em Python 3 para o terminal da VM ⭐ MVP

**User Story**: Como Grok bot, quero um comando único no terminal que fale com a API
usando a chave do ambiente, para não montar `curl` à mão.

**Why P1**: É a "API geral" pedida: uma entrada que cobre toda rota liberada.

**Acceptance Criteria**:

1. The CLI SHALL ser um único arquivo `cli/livelab.py` que roda com `python3 cli/livelab.py`
   sem nenhum pacote fora da stdlib.
2. IF `LIVELAB_API_KEY` não está definida THEN the CLI SHALL imprimir
   `LIVELAB_API_KEY não definida` em stderr e sair com código 2.
3. WHEN `livelab api GET /v1/lives -q data_inicio=2026-09-01` THEN the CLI SHALL fazer
   `GET /v1/lives?data_inicio=2026-09-01` com `X-API-Key` e imprimir o body JSON em stdout,
   saindo 0 quando o status for 2xx.
4. WHEN `livelab api POST /v1/marcas -d '{"nome":"X","tipo":"afiliada"}'` THEN the CLI
   SHALL enviar o body como `application/json` e imprimir a resposta.
5. WHEN `livelab api POST /v1/marcas -f corpo.json` THEN the CLI SHALL ler o body do arquivo.
6. WHEN `livelab ingest relatorio.xlsx --marca-id <uuid> --apresentadora-id <uuid>
   [--criar-lives] [--preview]` THEN the CLI SHALL enviar
   `{"filename","content_base64","marca_id","apresentadora_id","criar_lives"}` para
   `/v1/analytics/imports/ingest` (ou `/preview` com `--preview`) e imprimir a resposta.
7. IF o arquivo do `ingest` tiver mais de 5 MB THEN the CLI SHALL recusar antes de enviar,
   com mensagem em stderr e código 2.
8. IF a API responder status fora de 2xx THEN the CLI SHALL imprimir em stderr
   `{"status": <n>, "error": <body>}` e sair com código 1.
9. IF a resposta for 403 THEN the CLI SHALL acrescentar em stderr a linha
   `rota não liberada para chave de API — veja: livelab rotas`.
10. IF houver erro de rede, DNS ou timeout (60 s) THEN the CLI SHALL sair com código 3.
11. WHEN `livelab rotas` THEN the CLI SHALL imprimir a tabela método/rota/uso das rotas
    liberadas, idêntica à allowlist de `src/plugins/auth.js`.
12. The CLI SHALL nunca imprimir o valor de `LIVELAB_API_KEY`, inclusive com `--verbose`.
13. WHEN `--verbose` THEN the CLI SHALL imprimir em stderr método, URL e status de cada
    chamada.
14. WHEN `livelab --help` ou `livelab <comando> --help` THEN the CLI SHALL listar os
    comandos e os campos aceitos por cada um.

**Independent Test**: `test/cli_livelab.test.js` sobe um Fastify falso numa porta local,
aponta `LIVELAB_API_URL` para ele e roda `python3 cli/livelab.py ...` via `child_process`,
conferindo headers recebidos, body enviado, stdout e exit code.

---

### P2: Chip BOT no painel React

**User Story**: Como Ana/Wagner, quero ver um chip BOT na lista de lives, no detalhe, no
histórico de GMV, nas marcas, nas apresentadoras e nos lotes de import.

**Why P2**: A tag no dado é o que garante; o chip é o que a equipe enxerga.

**Acceptance Criteria**:

1. WHEN uma live com `origem_dados = 'bot'` aparece na lista ou no detalhe THEN the UI
   SHALL renderizar `<Badge tone="sistema">BOT</Badge>` ao lado do nome/status.
2. WHEN uma revisão de GMV com `origem_dados = 'bot'` aparece em `HistoricoGmvModal` THEN
   the UI SHALL mostrar `BOT` na coluna "Alterado por".
3. WHEN marca ou apresentadora com `origem_dados = 'bot'` aparece na lista THEN the UI
   SHALL renderizar o chip BOT na linha.
4. WHEN lote de import com `origem_dados = 'bot'` aparece em `AnalyticsPage` THEN the UI
   SHALL renderizar o chip BOT na linha.
5. WHEN `origem_dados` é `manual`, `api` ou ausente THEN the UI SHALL não renderizar chip.

**Independent Test**: teste de helper `isBot(item)` + `npx vitest run` no react-app;
visual: `visual-check` da lista de lives com uma live bot.

---

### P2: Comandos nomeados na CLI e doc atualizado

**User Story**: Como Grok bot, quero `livelab lives list`, `livelab marcas criar --nome X`
etc., para errar menos que com rota crua.

**Acceptance Criteria**:

1. WHEN `livelab lives list|get <id>|criar|editar <id>`, `marcas list|criar|editar <id>`,
   `apresentadoras list|criar|editar <id>`, `comissoes list`, `imports get <id>` THEN the
   CLI SHALL traduzir para a rota correspondente e delegar ao mesmo caminho de `api`.
2. WHEN `criar`/`editar` recebem `-d` ou `-f` THEN the CLI SHALL usar esse body sem
   transformar.
3. `docs/api-automacao.md` SHALL documentar `POST /v1/lives/manual`, o campo
   `origem_dados = 'bot'` e a seção "CLI" com instalação (`curl -O` do arquivo) e exemplos.

---

## Edge Cases

- IF a chave tem `criado_por` preenchido (usuário real) THEN the system SHALL mesmo assim
  gravar `origem_dados = 'bot'` (a origem vem de `viaApiKey`, não do `sub`).
- IF o body de `POST /v1/lives/manual` por chave traz `origem_dados: 'api'` THEN the
  system SHALL ignorar e gravar `'bot'`.
- WHEN a migration roda em banco que já tem `lives_origem_dados_check` THEN the migration
  SHALL substituir a constraint sem falhar (`DROP CONSTRAINT IF EXISTS` + `ADD`).
- WHEN `historico-gmv` devolve revisão antiga sem `origem_dados` THEN o valor SHALL ser
  `'manual'` (DEFAULT da coluna).
- IF `livelab api` recebe rota sem `/v1/` na frente THEN the CLI SHALL prefixar `/v1`
  (`lives` vira `/v1/lives`).

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
|---|---|---|---|
| BOT-01 | P1: origem bot em marcas (AC1) | Tasks | Pending |
| BOT-02 | P1: origem bot em apresentadoras (AC2) | Tasks | Pending |
| BOT-03 | P1: origem bot em lives manual + iniciar (AC3, AC4) | Done | Done (T3) |
| BOT-04 | P1: origem bot em live criada pelo ingest (AC5) | Tasks | Pending |
| BOT-05 | P1: origem bot em lote de import (AC6) | Tasks | Pending |
| BOT-06 | P1: origem bot em revisão de GMV (AC7) | Done | Done (T3) |
| BOT-07 | P1: JWT continua 'manual' (AC9) | Done | Done (T2 helper; rotas em T3–T6) |
| BOT-08 | P1: PATCH não reescreve origem (AC8) | Done | Done (T3) |
| BOT-09 | P1: GETs devolvem origem_dados (AC10) | Tasks | Pending |
| BOT-10 | P1: CHECK no banco (AC11) | Done | Done (T1, migration 140) |
| MAN-01 | P1: lives/manual na allowlist + papel (AC1–AC3) | Done | Done (T3) |
| CLI-01 | P1: arquivo único stdlib (AC1) | Tasks | Pending |
| CLI-02 | P1: chave ausente exit 2 (AC2) | Tasks | Pending |
| CLI-03 | P1: `api` GET/POST/PATCH com -q/-d/-f (AC3–AC5) | Tasks | Pending |
| CLI-04 | P1: `ingest` base64 + preview + teto 5 MB (AC6, AC7) | Tasks | Pending |
| CLI-05 | P1: erros: exit 1 / 403 dica / exit 3 rede (AC8–AC10) | Tasks | Pending |
| CLI-06 | P1: `rotas`, `--verbose`, `--help`, chave nunca impressa (AC11–AC14) | Tasks | Pending |
| UI-01 | P2: chip BOT lives lista+detalhe (AC1) | Tasks | Pending |
| UI-02 | P2: BOT no histórico de GMV (AC2) | Tasks | Pending |
| UI-03 | P2: chip em marcas, apresentadoras, imports (AC3, AC4) | Tasks | Pending |
| UI-04 | P2: sem chip para manual/api (AC5) | Tasks | Pending |
| CLI-07 | P2: comandos nomeados (AC1, AC2) | Tasks | Pending |
| DOC-01 | P2: docs/api-automacao.md (AC3) | Tasks | Pending |
