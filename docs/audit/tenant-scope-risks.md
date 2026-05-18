# Riscos de Vazamento Cross-Tenant

> Auditoria gerada em: 2026-05-18
> Branch: `stabilization/core-restructure`
> Contexto: O banco usa RLS do Supabase como primeira linha de defesa. O comentário no código (`// Defesa em profundidade: role postgres do Supabase tem BYPASSRLS`) documenta o problema: a role de serviço tem `rolbypassrls=true`, tornando cláusulas `WHERE tenant_id` explícitas a única proteção real.

---

## Endpoints sem filtro `tenant_id` explícito (dependem somente do RLS)

### CRÍTICO — Queries dentro de `withTenant` sem `WHERE tenant_id` explícito

| Arquivo | Linha | Endpoint | Tabela | Query |
|---|---|---|---|---|
| cabines.js | 513 | GET `/v1/cabines/:id/historico` | `cabines` | `SELECT id FROM cabines WHERE id = $1` — sem `AND tenant_id` |
| cabines.js | 520–527 | GET `/v1/cabines/:id/historico` | `lives` | `SELECT ... FROM lives l JOIN clientes cl ... WHERE l.cabine_id = $1 AND ...` — sem `AND l.tenant_id` |
| cabines.js | 531–544 | GET `/v1/cabines/:id/historico` | `lives` | SELECT melhores horários sem `AND tenant_id` |
| cabines.js | 546–555 | GET `/v1/cabines/:id/historico` | `lives` | SELECT desempenho mensal sem `AND tenant_id` |
| cabines.js | 569–571 | GET `/v1/cabines/:id/historico` | `lives` | SELECT totais sem `AND tenant_id` |
| cabines.js | 573–593 | GET `/v1/cabines/:id/historico` | `lives`, `clientes` | SELECT lives recentes sem `AND l.tenant_id` |
| cabines.js | 642 | GET `/v1/cabines/:id/live-atual` | `cabines` | `SELECT live_atual_id, status FROM cabines WHERE id = $1` — sem tenant_id |
| cabines.js | 649–653 | GET `/v1/cabines/:id/live-atual` | `lives` | `SELECT id FROM lives WHERE cabine_id = $1 AND status = 'em_andamento'` — sem tenant_id |
| cabines.js | 682–694 | GET `/v1/cabines/:id/live-atual` | `lives`, `cabines`, `users`, `clientes`, `contratos` | JOIN query sem cláusula tenant_id em nenhuma tabela |
| cabines.js | 704–712 | GET `/v1/cabines/:id/live-atual` | `live_snapshots` | `WHERE live_id = $1` — sem tenant_id |
| cabines.js | 716–720 | GET `/v1/cabines/:id/live-atual` | `live_products` | `WHERE live_id = $1` — sem tenant_id |
| cabines.js | 293 | DELETE `/v1/cabines/:id` | `cabines` | `SELECT id, status, live_atual_id, contrato_id FROM cabines WHERE id = $1` — sem tenant_id |
| cabines.js | 310–311 | DELETE `/v1/cabines/:id` | `lives`, `live_requests` | SELECTs sem tenant_id para verificação FK |
| cabines.js | 341 | PATCH `/v1/cabines/:id` | `cabines` | UPDATE sem `AND tenant_id` |
| cabines.js | 363–369 | PATCH `/v1/cabines/:id/reservar` | `cabines` | `SELECT ... FROM cabines WHERE id = $1 FOR UPDATE` — sem tenant_id |
| cabines.js | 387–393 | PATCH `/v1/cabines/:id/reservar` | `contratos` | `SELECT id, cliente_id, status FROM contratos WHERE id = $1 FOR UPDATE` — sem tenant_id |
| cabines.js | 406–411 | PATCH `/v1/cabines/:id/reservar` | `cabines` | `SELECT id, numero FROM cabines WHERE contrato_id = $1 LIMIT 1` — sem tenant_id |
| cabines.js | 456–462 | PATCH `/v1/cabines/:id/liberar` | `cabines` | `SELECT ... FROM cabines WHERE id = $1 FOR UPDATE` — sem tenant_id |
| cabines.js | 868–874 | PATCH `/v1/cabines/:id/status` | `cabines` | `SELECT ... FROM cabines WHERE id = $1 FOR UPDATE` — sem tenant_id |
| cabines.js | 941–946 | POST `/v1/lives` | `cabines` | `SELECT ... FROM cabines WHERE id = $1 FOR UPDATE` — sem tenant_id |
| cabines.js | 1220–1222 | PATCH `/v1/lives/:id` | `lives` | `SELECT id, ... FROM lives WHERE id = $1 AND status = 'encerrada' FOR UPDATE` — sem tenant_id |
| cabines.js | 1347 | DELETE `/v1/lives/:id` | `lives` | `SELECT id, status FROM lives WHERE id = $1` — sem tenant_id |

### ALTO RISCO — `/v1/cabines/fila-ativacao` (cabines.js:229)
Query sem `WHERE ct.tenant_id`:
```sql
SELECT ct.id, ct.cliente_id, cl.nome, ...
FROM contratos ct
JOIN clientes cl ON cl.id = ct.cliente_id
WHERE ct.status = 'ativo'
  AND NOT EXISTS (SELECT 1 FROM cabines cb WHERE cb.contrato_id = ct.id)
ORDER BY ct.ativado_em DESC NULLS LAST, ct.criado_em DESC
```
**Risco**: Se RLS falhar, retorna contratos de todos os tenants. Está dentro de `withTenant` mas não tem `AND ct.tenant_id = $x` explícito.

---

## Queries que usam `app.db.query` sem `withTenant`

Estas queries usam a conexão global (sem o `set_config` de `app.tenant_id`), o que significa que **não há RLS** sendo aplicado:

| Arquivo | Linha | Endpoint | Tabela | Risco |
|---|---|---|---|---|
| tenants.js | 33–55 | GET `/v1/tenants` | `lives`, `tenants`, `users` | Intencional — master vê tudo; só `franqueador_master` acessa |
| tenants.js | 61–85 | GET `/v1/tenants/:id` | `lives`, `tenants`, `users` | Intencional — filtrado por `WHERE t.id = $1` |
| tenants.js | 98 | POST `/v1/tenants` | `users` | `SELECT id FROM users WHERE email = $1` — busca global para verificar email único |
| tenants.js | 162 | PATCH `/v1/tenants/:id` | `tenants` | Intencional — master only |
| tenants.js | 216 | GET `/v1/master/tiktok-apps` | `tenants` | Intencional — master vê todos |
| cabines.js | 1527–1533 | PATCH `/v1/lives/:id/encerrar` | `tenants` | Intencional — lê email de notificação do tenant (documentado no código) |
| franqueado.js | 171, 337, 461, 537, etc. | `/v1/master/*` e `/v1/franqueado/*` | `lives`, `contratos`, `clientes`, etc. | Master routes — variar risk dependendo de filtro por tenant_id |
| manuais.js | 30, 45, 73, 83 | GET/POST/PATCH/DELETE `/v1/manuais` | `manuais` | **Sem filtro tenant_id** — tabela manuais parece global? Verificar schema |
| notificacoes.js | 78 | GET `/v1/notificacoes` | `tenants` | Lê settings do tenant — intencional |
| boletos.js | 179, 199 | POST webhook-related | `boletos`, `tenants` | Webhook handler — verificar escopo |

---

## Endpoints públicos (sem autenticação JWT)

Estes endpoints não exigem token JWT e são acessíveis por qualquer cliente:

| Método | Path | Proteção alternativa | Arquivo |
|---|---|---|---|
| POST | `/v1/auth/login` | Rate limit (5/min em prod) | auth.js |
| POST | `/v1/auth/refresh` | Rate limit (10/min em prod) | auth.js |
| POST | `/v1/auth/aceitar-convite` | Token de convite (72h, hash SHA256) | auth.js |
| POST | `/v1/auth/redefinir-senha` | Token de reset | auth.js |
| POST | `/v1/auth/forgot-password` | Rate limit | auth.js |
| GET | `/v1/public/ranking` | Nenhuma (dados anonimizados) | franqueado.js:1339 |
| GET | `/health` | HEALTH_CHECK_TOKEN opcional (timing-safe) | app.js:192 |
| GET | `/v1/webhooks/appmax/validate` | Nenhuma (só retorna app_id) | appmax.js:43 |
| POST | `/v1/webhooks/appmax/validate` | Rate limit (30/min) | appmax.js:54 |
| POST | `/v1/webhooks/appmax` | Token de webhook (header) | appmax.js:68 |
| POST | `/v1/webhooks/bio-crm` | HMAC SHA256 (X-Livelab-Signature) | webhook_bio_crm.js |

---

## Análise de risco por nível de criticidade

### CRÍTICO (dados sensíveis de negócio sem proteção explícita de tenant)
1. **GET `/v1/cabines/:id/historico`** — 6+ queries contra `lives` e `clientes` sem `AND tenant_id`. Se um atacante adivinhar o UUID de uma cabine de outro tenant, obtém histórico de faturamento e clientes. **Mitigação recomendada**: adicionar `AND l.tenant_id = [tenant_id from user]` em todas as subqueries do historico.

2. **GET `/v1/cabines/:id/live-atual`** — SELECT contra `cabines`, `lives`, `contratos`, `clientes`, `live_snapshots`, `live_products` sem `AND tenant_id`. O UUID da live é previsível em sistemas com múltiplos tenants.

### ALTO
3. **PATCH `/v1/cabines/:id/reservar`** e **PATCH `/v1/cabines/:id/status`** — Query de `cabines FOR UPDATE` sem tenant_id. Dentro do `withTenant` com RLS, mas sem defesa em profundidade.

4. **GET `/v1/cabines/fila-ativacao`** — Retorna contratos e clientes sem filtro explícito de tenant.

5. **POST `/v1/lives`** e **PATCH `/v1/lives/:id/encerrar`** — Queries transacionais críticas sem tenant_id nas SELECTs intermediárias.

### MÉDIO
6. **PATCH `/v1/clientes/:id`** (clientes.js:257) — UPDATE sem `AND tenant_id`. Dentro de `withTenant`, mas sem defesa em profundidade.

7. **POST `/v1/clientes/logo/favicon`** (clientes.js:207) — UPDATE via `user_id` (sem tenant_id). Potencial para atualizar logo de cliente de outro tenant se `user_id` for adivinhado.

---

## Recomendações prioritárias

1. Adicionar `AND l.tenant_id = $N` em todas as queries do endpoint `/v1/cabines/:id/historico` (cabines.js linhas 520–593)
2. Adicionar `AND c.tenant_id = $N` / `AND l.tenant_id = $N` no endpoint `/v1/cabines/:id/live-atual` (cabines.js linhas 642, 649, 682–720)
3. Adicionar `AND ct.tenant_id = $N` na query de `/v1/cabines/fila-ativacao` (cabines.js linha 242)
4. Auditar `manuais.js` — as queries usam `app.db.query` sem RLS e sem filtro de tenant
5. Adicionar `AND tenant_id = $N` nas queries de `FOR UPDATE` em reservar/liberar/status (defesa em profundidade)
