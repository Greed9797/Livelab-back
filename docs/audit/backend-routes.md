# Inventário de Rotas Backend

> Auditoria gerada em: 2026-05-18
> Branch: `stabilization/core-restructure`
> Arquivo base: `src/app.js`

---

## Legenda
- **Autenticado**: `requirePapel` ou `authenticate` no `preHandler`
- **Filtra tenant**: uso de `app.withTenant` + `WHERE tenant_id = $x` explícito, ou apenas via RLS Supabase
- **RLS-only**: dentro de `withTenant` mas sem cláusula `WHERE tenant_id` explícita (depende somente do RLS)

---

## Rotas de Autenticação (`src/routes/auth.js`)

| Método | Path | Autenticado | Roles | Filtra tenant | Arquivo |
|--------|------|-------------|-------|---------------|---------|
| POST | `/v1/auth/login` | Não | — | N/A | auth.js |
| POST | `/v1/auth/refresh` | Não | — | N/A | auth.js |
| POST | `/v1/auth/logout` | Sim | qualquer autenticado | N/A | auth.js |
| PATCH | `/v1/auth/senha` | Sim | qualquer autenticado | N/A | auth.js |
| POST | `/v1/auth/aceitar-convite` | Não | — | N/A | auth.js |
| POST | `/v1/auth/redefinir-senha` | Não | — | N/A | auth.js |
| POST | `/v1/auth/forgot-password` | Não | — | N/A | auth.js |

---

## Rotas de Cabines e Lives (`src/routes/cabines.js`)

> **Nota:** Não existe `src/routes/lives.js` separado. Todos os endpoints `/v1/lives` estão dentro de `cabines.js`.

| Método | Path | Autenticado | Roles | Filtra tenant | Arquivo |
|--------|------|-------------|-------|---------------|---------|
| GET | `/v1/cabines` | Sim | READ_CABINES | Sim — `WHERE c.tenant_id = $1::uuid` (linha 209) | cabines.js:146 |
| GET | `/v1/cabines/fila-ativacao` | Sim | READ_CABINES | **RLS-only** — query sem `WHERE ct.tenant_id` explícito (linha 242-259) | cabines.js:229 |
| POST | `/v1/cabines` | Sim | WRITE_CABINES | Sim — `$1` = tenant_id no INSERT | cabines.js:262 |
| DELETE | `/v1/cabines/:id` | Sim | WRITE_CABINES | RLS-only — SELECT sem `AND tenant_id = $x` | cabines.js:287 |
| PATCH | `/v1/cabines/:id` | Sim | WRITE_CABINES | RLS-only — UPDATE sem tenant_id explícito | cabines.js:328 |
| PATCH | `/v1/cabines/:id/reservar` | Sim | READ_CABINES | RLS-only — SELECT cabine/contrato sem tenant_id explícito | cabines.js:352 |
| PATCH | `/v1/cabines/:id/liberar` | Sim | READ_CABINES | RLS-only | cabines.js:449 |
| GET | `/v1/cabines/:id/historico` | Sim | READ_CABINES | **Risco** — queries `FROM lives` sem tenant_id (linhas 520–593) | cabines.js:506 |
| GET | `/v1/cabines/:id/live-atual` | Sim | READ_CABINES | Parcial — SELECT final sem tenant_id (linha 682–694) | cabines.js:637 |
| POST | `/v1/cabines/:id/closer-notification` | Sim | WRITE_LIVES | RLS-only | cabines.js:757 |
| GET | `/v1/cabines/:id/closer-notifications/stream` | Sim | READ_LIVES | RLS-only (SSE) | cabines.js:811 |
| PATCH | `/v1/cabines/:id/status` | Sim | READ_CABINES | RLS-only | cabines.js:856 |
| POST | `/v1/lives` | Sim | READ_CABINES | Sim — `tenant_id` no INSERT + `withTenant` | cabines.js:928 |
| POST | `/v1/lives/manual` | Sim | franqueador_master, franqueado, gerente, produtor_live | Sim — `withTenant` | cabines.js:1104 |
| PATCH | `/v1/lives/:id` | Sim | franqueador_master, franqueado, gerente, produtor_live | RLS-only — UPDATE sem tenant_id | cabines.js:1208 |
| GET | `/v1/lives` | Sim | READ_CABINES | Sim — `WHERE l.tenant_id = $1::uuid` | cabines.js:1317 |
| DELETE | `/v1/lives/:id` | Sim | franqueador_master, franqueado, gerente, produtor_live | RLS-only — SELECT sem tenant_id | cabines.js:1344 |
| PATCH | `/v1/lives/:id/encerrar` | Sim | READ_CABINES | RLS-only | cabines.js:1368 |

---

## Rotas de Solicitações (`src/routes/solicitacoes.js`)

| Método | Path | Autenticado | Roles | Filtra tenant | Arquivo |
|--------|------|-------------|-------|---------------|---------|
| GET | `/v1/solicitacoes` | Sim | READ_SOLICITACOES | Sim — `WHERE lr.tenant_id = $1` | solicitacoes.js:17 |
| PATCH | `/v1/solicitacoes/:id/aprovar` | Sim | WRITE_SOLICITACOES | Sim — `WHERE id = $1 AND tenant_id = $2` | solicitacoes.js:73 |
| PATCH | `/v1/solicitacoes/:id/recusar` | Sim | WRITE_SOLICITACOES | Sim — `WHERE id = $1 AND tenant_id = $2` | solicitacoes.js:176 |
| POST | `/v1/solicitacoes` | Sim | WRITE_SOLICITACOES | Sim — tenant_id no INSERT | solicitacoes.js:211 |

---

## Rotas de Agenda (`src/routes/agenda.js`)

| Método | Path | Autenticado | Roles | Filtra tenant | Arquivo |
|--------|------|-------------|-------|---------------|---------|
| GET | `/v1/agenda` | Sim | READ_AGENDA | Sim — `ae.tenant_id = $1::uuid` | agenda.js:76 |
| POST | `/v1/agenda` | Sim | WRITE_AGENDA | Sim — tenant_id no INSERT | agenda.js:112 |
| PATCH | `/v1/agenda/:id` | Sim | WRITE_AGENDA | Sim — `WHERE id = $1 AND tenant_id = $2::uuid` | agenda.js:149 |
| DELETE | `/v1/agenda/:id` | Sim | WRITE_AGENDA | Sim — `WHERE id = $1 AND tenant_id = $2::uuid` | agenda.js:196 |

---

## Rotas de Tenants (`src/routes/tenants.js`)

| Método | Path | Autenticado | Roles | Filtra tenant | Arquivo |
|--------|------|-------------|-------|---------------|---------|
| GET | `/v1/tenants` | Sim | franqueador_master | N/A (lê todos) — usa `app.db.query` direto | tenants.js:32 |
| GET | `/v1/tenants/:id` | Sim | franqueador_master | Sim — `WHERE t.id = $1` | tenants.js:60 |
| POST | `/v1/tenants` | Sim | franqueador_master | N/A (cria novo tenant) | tenants.js:90 |
| PATCH | `/v1/tenants/:id` | Sim | franqueador_master | Sim — `WHERE id = $x` | tenants.js:142 |
| PATCH | `/v1/tenants/:id/status` | Sim | franqueador_master | Sim — `WHERE id = $2` | tenants.js:172 |
| GET | `/v1/master/tiktok-apps` | Sim | franqueador_master | N/A (lê todos os tenants) | tenants.js:214 |

---

## Rotas de Clientes (`src/routes/clientes.js`)

| Método | Path | Autenticado | Roles | Filtra tenant | Arquivo |
|--------|------|-------------|-------|---------------|---------|
| POST | `/v1/clientes` | Sim | WRITE_CLIENTES | Sim — tenant_id no INSERT | clientes.js:57 |
| POST | `/v1/clientes/geocode-pending` | Sim | WRITE_CLIENTES | RLS-only — usa `current_setting` | clientes.js:101 |
| GET | `/v1/clientes/metricas` | Sim | READ_CLIENTES | RLS-only — usa `current_setting` | clientes.js:143 |
| GET | `/v1/clientes` | Sim | READ_CLIENTES | Sim — `WHERE cl.tenant_id = $1::uuid` | clientes.js:161 |
| GET | `/v1/clientes/:id` | Sim | READ_CLIENTES | Sim — `WHERE id = $1 AND tenant_id = $2` | clientes.js:191 |
| POST | `/v1/clientes/logo/favicon` | Sim | cliente_parceiro | RLS-only — UPDATE sem tenant_id explícito (usa `user_id`) | clientes.js:207 |
| PATCH | `/v1/clientes/:id` | Sim | WRITE_CLIENTES | RLS-only — UPDATE sem `WHERE tenant_id` | clientes.js:257 |
| DELETE | `/v1/clientes/:id` | Sim | franqueado, gerente, franqueador_master | Sim — `WHERE id = $1 AND tenant_id = $2::uuid` | clientes.js:299 |

---

## Rotas de Usuários (`src/routes/usuarios.js`)

| Método | Path | Autenticado | Roles | Filtra tenant | Arquivo |
|--------|------|-------------|-------|---------------|---------|
| GET | `/v1/usuarios` | Sim | franqueado, franqueador_master | Sim — `tenant_id = $1` (condição) | usuarios.js:47 |
| POST | `/v1/usuarios/convidar` | Sim | franqueado, franqueador_master | Sim — `withTenant` + `tenant_id` no INSERT | usuarios.js:75 |
| PATCH | `/v1/usuarios/:id` | Sim | franqueado, franqueador_master | Sim — `WHERE id = $x AND tenant_id = $y` | usuarios.js:227 |
| POST | `/v1/usuarios/:id/reset-senha` | Sim | franqueado, franqueador_master | Sim — `WHERE id = $2 AND tenant_id = $3` | usuarios.js:295 |
| POST | `/v1/usuarios/:id/force-logout` | Sim | franqueado, franqueador_master | Sim — `WHERE id = $1 AND tenant_id = $2` | usuarios.js:325 |
| POST | `/v1/usuarios/:id/reenviar-convite` | Sim | franqueado, franqueador_master | Sim — `WHERE id = $1 AND tenant_id = $2` | usuarios.js:352 |
| GET | `/v1/usuarios/convites-pendentes` | Sim | franqueado, franqueador_master | Sim — `WHERE u.tenant_id = $1` | usuarios.js:396 |
| POST | `/v1/usuarios/convites/reenviar-bulk` | Sim | franqueado, franqueador_master | Sim — `WHERE id = $1 AND tenant_id = $2` | usuarios.js:424 |
| DELETE | `/v1/usuarios/convites/:id` | Sim | franqueado, franqueador_master | Sim — `WHERE id = $1 AND tenant_id = $2` | usuarios.js:488 |
| DELETE | `/v1/usuarios/:id` | Sim | franqueado, franqueador_master | Sim — `WHERE id = $1 AND tenant_id = $2` | usuarios.js:520 |

---

## Outras Rotas Relevantes

| Módulo | Método | Path | Autenticado | Roles | Arquivo |
|--------|--------|------|-------------|-------|---------|
| home | GET | `/v1/home/dashboard` | Sim | franqueado, gerente | home.js |
| analytics | GET | `/v1/analytics/dashboard` | Sim | READ_ANALYTICS | analytics.js |
| financeiro | GET | `/v1/financeiro/resumo` | Sim | READ_FINANCEIRO | financeiro.js |
| financeiro | GET | `/v1/financeiro/faturamento` | Sim | READ_FINANCEIRO | financeiro.js |
| financeiro | GET | `/v1/financeiro/fluxo-caixa` | Sim | READ_FINANCEIRO | financeiro.js |
| financeiro | POST/GET/DELETE | `/v1/financeiro/custos` | Sim | WRITE/READ_FINANCEIRO | financeiro.js |
| boletos | GET | `/v1/boletos` | Sim | READ_BOLETOS | boletos.js |
| contratos | GET/POST/PATCH/DELETE | `/v1/contratos` | Sim | READ/WRITE_CONTRATOS | contratos.js |
| lives (apresentadores) | POST/DELETE/GET | `/v1/lives/:id/apresentadores` | Sim | franqueado, gerente | live_apresentadores.js |
| apresentadoras | GET/POST/PATCH/DELETE | `/v1/apresentadoras` | Sim | READ/WRITE_APRESENTADORAS | apresentadoras.js |
| leads | GET/POST/PATCH/DELETE | `/v1/leads` | Sim | READ/WRITE_LEADS | leads.js |
| marcas | GET/POST/PATCH/DELETE | `/v1/marcas` | Sim | READ/WRITE_MARCAS | marcas.js |
| videos | GET/POST/PATCH/DELETE | `/v1/videos` | Sim | READ/WRITE_VIDEOS | videos.js |
| vendas_atribuidas | GET | `/v1/vendas-atribuidas` | Sim | READ_VENDAS_ATRIBUIDAS | vendas_atribuidas.js |
| comissoes | GET | `/v1/comissoes/resumo` | Sim | READ_COMISSOES | comissoes.js |
| configuracoes | GET/PATCH | `/v1/configuracoes` | Sim | READ/WRITE_CONFIGURACOES | configuracoes.js |
| knowledge | GET | `/v1/knowledge/categories` | Sim | qualquer autenticado | knowledge.js |
| cep | GET | `/v1/cep/:cep` | Sim | qualquer autenticado | cep.js |
| notificacoes | GET | `/v1/notificacoes` | Sim | qualquer autenticado | notificacoes.js |
| audit_log | GET | `/v1/audit-log` | Sim | READ_AUDIT_LOG | audit_log.js |
| tiktok | GET/POST | `/v1/tiktok/*` | Sim/Não (OAuth) | varia | tiktok.js |
| **franqueado (público)** | GET | `/v1/public/ranking` | **Não** | — | franqueado.js:1339 |
| **health** | GET | `/health` | **Não** (opcional token) | — | app.js:192 |
| **webhook bio-crm** | POST | `/v1/webhooks/bio-crm` | Não (HMAC) | — | webhook_bio_crm.js |
| **webhook appmax** | GET/POST | `/v1/webhooks/appmax/validate` | Não | — | appmax.js |
| **webhook appmax** | POST | `/v1/webhooks/appmax` | Não (token header) | — | appmax.js |
| onboarding | POST | `/v1/onboarding` | Sim | cliente_parceiro | onboarding.js |
| cliente portal | GET/POST/PATCH | `/v1/cliente/*` | Sim | cliente_parceiro | cliente_portal.js |

---

## Totais

- Total de módulos de rota: **39 arquivos** em `src/routes/`
- Endpoints públicos (sem JWT): `/v1/auth/login`, `/v1/auth/refresh`, `/v1/auth/aceitar-convite`, `/v1/auth/redefinir-senha`, `/v1/auth/forgot-password`, `/v1/public/ranking`, `/health`, webhooks com verificação HMAC/token
- **Achado:** Não existe `src/routes/lives.js` separado — todas as rotas `/v1/lives` estão em `cabines.js`
