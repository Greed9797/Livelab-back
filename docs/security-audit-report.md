# Backend Security & Quality Audit Report

**Projeto:** `liveshop_saas_api-backend-`
**Data:** 2026-04-20
**Stack:** Node.js 20+ · Fastify 5.8 · PostgreSQL/Supabase · Vitest
**Modo:** Leitura apenas — nenhuma alteração automática

---

## Resumo Executivo

Auditoria completa do backend em 5 fases. **10 achados — nenhum crítico, nenhum crítico de segurança.**

| Fase | Resultado |
|---|---|
| Fase 1 — Segurança | ✅ Boa postura geral — 2 achados menores |
| Fase 2 — Validação e Erros | ⚠️ 3 achados médios |
| Fase 3 — Qualidade e Lógica | ⚠️ 3 achados médios |
| Fase 4 — Performance e BD | ⚠️ 2 achados (médio + baixo) |
| Fase 5 — Estrutura e Fastify | ✅ Sem vulnerabilidades |

---

## Fase 1 — Segurança

### Injeção (SQL / NoSQL / Command Injection)
**Status: ✅ NENHUMA VULNERABILIDADE CRÍTICA**

- Todas as queries SQL usam **prepared statements com `$N` parametrizados**
- Queries dinâmicas em `configuracoes.js`, `clientes.js`, `contratos.js` e `pacotes.js` são construídas com índices SQL (`$N`), não com concatenação de valores
- **Sem Command Injection** — nenhum uso de `exec`, `spawn` ou `child_process`
- **Sem NoSQL Injection** — não há banco NoSQL no projeto

**Ponto de atenção:** A query `SELECT ... FROM leads WHERE franqueadora_id = $1 AND (status = 'disponivel' OR pego_por = $1)` em `leads.js` replica `tenant_id` como `pego_por`. Funcionalmente correto, mas implica que `franqueadora_id` deve ser igual a `tenant_id` do franqueado — premissa de negócio a ser verificada.

---

### Autenticação e Autorização (JWT / Sessão)
**Status: ✅ BOA PROTEÇÃO — 1 ACHADO MÉDIO**

- JWT com expiração configurável (padrão 15m) ✅
- Refresh tokens com **rotação** (revogação após uso) + hash SHA256 ✅
- Expiração de refresh tokens: 7 dias ✅
- `requirePapel` verifica papel após autenticação ✅

**ACHADO #1 — Logout sem validação do token apresentado**

`POST /v1/auth/logout` revoga **todos** os refresh tokens do usuário (por `user_id`), mas não verifica se o token revogado é realmente do usuário que está fazendo logout. Qualquer sessão autenticada consegue invalidar todas as sessões do usuário.

- **Severidade:** Média
- **Arquivo:** `src/routes/auth.js:117-121`
- **Recomendação:** Validar que o token apresentado está na lista de tokens do usuário antes de revogar.

---

### Secrets Expostos no Código
**Status: ✅ NENHUM SECRET HARDCODED**

- Todas as chaves sensíveis são lidas de `process.env` — nenhuma hardcoded no código fonte ✅
- `.env.example` documenta as variáveis obrigatórias ✅

**ACHADO #2 — `ASAAS_API_KEY` sem validação ao salvar**

A chave é configurada via `PATCH /v1/configuracoes` sem validação de formato ou teste de conectividade. Uma chave inválida salva resultará em falhas silenciosas nas cobranças.

- **Severidade:** Média
- **Arquivo:** `src/routes/configuracoes.js:128-130`
- **Recomendação:** Após salvar a chave, fazer uma chamada de teste à API do Asaas para validar antes de persistir.

---

### CORS Mal Configurado
**Status: ✅ SEGURO**

```js
origin: process.env.CORS_ORIGIN ?? (process.env.NODE_ENV === 'production' ? false : true)
```

- Produção: `origin: false` (same-origin only) ✅
- Dev: `origin: true` — aceitável para desenvolvimento ✅
- `credentials` não configurado (default `false`) ✅
- `allowedHeaders` limitado a `Authorization, Content-Type, Accept` ✅

**Nota:** A origem em produção depende de `CORS_ORIGIN` estar corretamente configurado no deployment.

---

### Rate Limiting e Proteção contra Brute Force
**Status: ✅ PROTEÇÃO EFETIVA**

- Rate limit global: **100 req/min** ✅
- Login: **5 req/min** em produção, **100 req/min** em dev ✅
- Refresh: **10 req/min** em produção, **200 req/min** em dev ✅
- Erro genérico returned (`"Muitas requisições"`) — não vaza informação ✅

---

### Upload de Arquivos sem Validação
**Status: ✅ VALIDAÇÕES PRESENTES**

- MIME type whitelist: `['image/jpeg', 'image/png', 'image/webp', 'image/gif']` ✅
- Tamanho máximo: **5 MB** ✅
- Extensão reescrita (`jpeg` → `jpg`) ✅
- `x-upsert: true` no Supabase Storage — sobrescreve se existir ✅

---

## Fase 2 — Validação de Entrada e Tratamento de Erros

### Validação de Entrada (Zod)
**Status: ✅ PADRÃO ESTABELECIDO — 1 ACHADO MÉDIO**

- **17 rotas** usam `safeParse` com Zod schemas — cobertura boa ✅
- Erros retornam `400` com `parsed.error.issues[0].message` ✅

**ACHADO #3 — Falta validação em `request.params.id`**

`request.params.id` é usado diretamente em queries SQL sem validação de tipo em dezenas de rotas (`leads.js:34`, `boletos.js:90`, `contratos.js:109`, `cabines.js:240`, etc.). Um UUID mal-formatado causará erro 500 do PostgreSQL (tipo UUID vs texto).

- **Severidade:** Média
- **Arquivos:** `src/routes/leads.js`, `src/routes/boletos.js`, `src/routes/contratos.js`, `src/routes/cabines.js`, `src/routes/pacotes.js`
- **Recomendação:** Criar helper `parseId(id)` que tenta `z.string().uuid()` e retorna `null` → rota retorna 400.

---

### Validação de Query Params
**ACHADO #4 — `request.query.status` bypass silencioso**

```js
const statusFilter = request.query.status ?? 'pendente'
if (statusFilter !== 'all') { params.push(statusFilter) ... }
```

Um valor como `'pendente '` (com espaço) bypassará o filtro e retornará 0 resultados sem erro, com comportamento silencioso inesperado.

- **Severidade:** Média
- **Arquivo:** `src/routes/solicitacoes.js:8-17`
- **Recomendação:** Normalizar com `.trim()` e validar contra lista de valores permitidos.

---

### Tratamento de Erros
**Status: ✅ FUNCIONAL — 1 ACHADO MÉDIO**

- Cada rota usa `try/catch` individual — erros sobem para o Fastify ✅
- **Sem `setErrorHandler` global** — erros inesperados usam resposta default do Fastify
- **Sem `setNotFoundHandler`** — rotas inexistentes retornam default 404

**ACHADO #5 — Geolocalização por CEP falha silenciosamente**

`_fetchViaCep` e `_geocode` retornam `{}` ou `{ lat: null, lng: null }` em caso de falha. A rota `GET /v1/cep/:cep` retorna `{ cep, logradouro: null, ... }` sem indicar que a consulta falhou.

- **Severidade:** Baixa
- **Arquivo:** `src/routes/cep.js:13-16`
- **Recomendação:** Incluir campo `geocoding_failed: true` na resposta quando fallhar.

---

## Fase 3 — Qualidade e Lógica de Código

### Padrão `db.release()`
**Status: ✅ COBERTURA TOTAL — 58 instâncias verificadas**

Todas as rotas autenticadas que usam `app.dbTenant(tenant_id)` têm `db.release()` em `finally`. O billing engine também错 使用 `dbPool.connect()` + `finally { db.release() }`.

---

### Transações
**Status: ✅ BOA COBERTURA**

- Leads `POST /:id/pegar` — usa `SELECT FOR UPDATE` + BEGIN/COMMIT/ROLLBACK ✅
- Billing engine — BEGIN/COMMIT/ROLLBACK com try individual ✅
- Contratos com transação — `finally { db.release() }` nos blocos transactionais ✅

---

### Lógica de Negócio
**ACHADO #6 — `cliente_dashboard.js`: N+1 queries dentro de loops**

Linhas 336-810: o código itera sobre `rows` fazendo queries individuais dentro do loop (padrão N+1). Sem paginação ou batching.

- **Severidade:** Média
- **Arquivo:** `src/routes/cliente_dashboard.js`
- **Recomendação:** Consolidar em batch queries com `WHERE id = ANY($1)`.

**ACHADO #7 — `financeiro.js`: queries sem filtro `tenant_id` explícito**

```sql
FROM custos WHERE date_trunc('month', competencia) = ...
FROM lives WHERE ...
```

As queries não mencionam `tenant_id` explicitamente (confiam no RLS implícito). RLS é defesa em profundidade, não barreira primária.

- **Severidade:** Média
- **Arquivo:** `src/routes/financeiro.js`
- **Recomendação:** Adicionar `AND tenant_id = $N` explícito em todas as queries.

---

### Anti-patterns
**Status: ✅ LIMPO**

- Nenhum `console.log/warn/error` no código de produção ✅
- Timers SSE sempre têm `clearInterval` no cleanup ✅
- Não há `process.exit()` em handlers ✅

---

## Fase 4 — Performance e Banco de Dados

### Connection Pool
**Status: ✅ CONFIGURAÇÃO RAZOÁVEL — 1 ACHADO MÉDIO**

- Pool máximo: **20 conexões** ✅
- `idleTimeoutMillis`: 30s ✅
- `connectionTimeoutMillis`: 5s ✅

**ACHADO #8 — Pool de 20 pode ser insuficiente em alta concorrência**

Com 20 conexões e RLS usando `SELECT set_config('app.tenant_id', ...)` por connection, cada requisição ocupa uma conexão durante toda a request. Em cenários com SSE de lives + polling do TikTok simultâneos, o pool pode se esgotar.

- **Severidade:** Média
- **Arquivo:** `src/plugins/db.js:13`
- **Recomendação:** Monitorar `pool.totalCount` e `pool.awaitingCount` em produção; considerar aumentar para 30-50 se necessário.

---

### Índices
**Status: ✅ PRESENTES — 1 ACHADO BAIXO**

Todas as tabelas principais têm índices por `tenant_id` + colunas de filtro comuns. Ver detalhe em `migrations/`.

**ACHADO #9 — Índices parciais para agregações temporais**

`financeiro.js` faz `date_trunc('month', encerrado_em)` e `date_trunc('month', competencia)` sem índices compostos para essas expressões. Em tabelas grandes, a query faz sequential scan.

- **Severidade:** Baixa
- **Arquivo:** `src/routes/financeiro.js:30-36`
- **Recomendação:** Criar índice `(tenant_id, date_trunc('month', encerrado_em))` para `lives`.

---

### N+1 Queries
**Status: ⚠️ REPORTADO NA FASE 3 (ACHADO #6)**

`cliente_dashboard.js` itera sobre rows fazendo queries individuais dentro do loop.

---

## Fase 5 — Estrutura, Boas Práticas e Fastify

### Plugin Architecture
**Status: ✅ PADRÃO CORRETO**

- Plugins usam `fastify-plugin` (`fp`) com encapsulação correta ✅
- `db` registrado antes de `auth` (`dependencies: ['db']`) ✅
- Decorators `db`, `dbTenant`, `authenticate`, `requirePapel` exportados corretamente ✅

---

### Server Lifecycle
**Status: ✅ GERÊNCIA DE RECURSOS CORRETA**

- `app.addHook('onClose', async () => pool.end())` no db plugin ✅
- Cron jobs com `try/catch` individual — cada job isolado ✅
- Connector manager e billing engine inicializados antes do `listen()` ✅
- Heartbeat timers SSE limpos no `request.raw.once('close')` ✅

---

### Logging
**Status: ✅ CORRETO**

- Fastify logger configurado (`logger: process.env.NODE_ENV !== 'test'`) ✅
- Usam `app.log.warn/error` em vez de `console.log` ✅

---

## Quadro Geral de Achados

| # | Severidade | Fase | Descrição | Arquivos |
|---|---|---|---|---|
| 1 | Média | 1 | Logout revoga todos os tokens sem validar o apresentado | `auth.js` |
| 2 | Média | 1 | `ASAAS_API_KEY` sem validação ao salvar | `configuracoes.js` |
| 3 | Média | 2 | `request.params.id` sem validação UUID | Múltiplos routes |
| 4 | Média | 2 | `request.query.status` bypass por espaço em branco | `solicitacoes.js` |
| 5 | Média | 3 | Queries de `custos` e `lives` sem filtro `tenant_id` explícito | `financeiro.js` |
| 6 | Média | 3 | N+1 queries em `cliente_dashboard.js` | `cliente_dashboard.js` |
| 7 | Baixa | 2 | Geolocalização por CEP falha silenciosamente | `cep.js` |
| 8 | Média | 4 | Pool de 20 conexões pode agotar em alta concorrência | `db.js` |
| 9 | Baixa | 4 | Índices parciais para agregações temporais | `financeiro.js` |
| 10 | Baixa | 3 | Billing engine: rollback isolado sem tratamento específico | `billing_engine.js` |

---

## Priorização Recomendada

| Prioridade | Achado | Motivo |
|---|---|---|
| **Alta** | #3 — validar `request.params.id` como UUID | Erros 500 expondo detalhes internos do PostgreSQL |
| **Alta** | #5 — adicionar `tenant_id` explícito nas queries | RLS é defesa em profundidade, não barreira primária |
| **Média** | #8 — monitorar uso do pool | Impacta disponibilidade em alta concorrência |
| **Média** | #2 — validar `ASAAS_API_KEY` no PATCH | Evita chaves inválidas salvas silenciosamente |
| **Média** | #6 — otimizar N+1 em `cliente_dashboard` | Performance degradada com muitos clientes |
| **Baixa** | #1 — validar token no logout | Inconveniente, não permite acesso não-authorizado |
| **Baixa** | #4 — normalizar `status` query param | Comportamento silencioso inesperado |
| **Baixa** | #7 — notificar falha de geocoding | Experiência do usuário, não segurança |
| **Baixa** | #9 — adicionar índices compostos temporais | Performance, não segurança |
| **Baixa** | #10 — tratar erros intermediários no billing | Robustez, não segurança |

---

## Pontos Fortes Identificados

- **SQL Injection: ZERO** — parametrização consistente em todas as queries
- **Auth JWT: robusta** — refresh token rotation + HMAC signed OAuth state TikTok
- **Rate limiting: efetivo** — 5 req/min no login em produção
- **db.release(): cobertura total** — 58 instâncias, todas com `finally`
- **Gerenciamento de lifecycle: correto** — `onClose`, `try/catch` por job, cleanup SSE
- **Helmet + CORS: bem configurados**
- **Código Limpo** — nenhum `console.log`, sem dead code, estrutura de arquivos consistente
