# Sentry Alert Rules — Recomendadas

Lista de alertas a serem configurados no dashboard Sentry do projeto LiveShop
SaaS. Configurar em **Alerts → Create Alert** (Issue Alerts ou Metric Alerts).

Tags relevantes injetadas pelo backend:
- `route` — URL da rota Fastify (ex: `/v1/cabines`)
- `method` — verbo HTTP
- `error_class` — `validation` | `auth` | `rbac` | `rate_limit` | `webhook_replay` | `app_error`
- `user.id`, `user.papel` — preenchidos via `setUser`

Breadcrumbs categorias:
- `auth` — login/logout/token verify
- `email` — envio Resend (success/failure)

---

## Backend alerts

### 1. Error rate spike
- **Tipo:** Metric Alert (Issues over time)
- **Condição:** `event.type:error` AND `environment:production`
- **Trigger:** issue_rate > 10/min por 5min consecutivos
- **Action:** notify on-call (Slack #liveshop-oncall)

### 2. Webhook payments fail
- **Tipo:** Issue Alert
- **Filter:** `tags.route` contains `/webhooks/` OR `/v1/webhook` AND `level:error`
- **Trigger:** any new event in last 1min
- **Action:** high priority — Slack #liveshop-payments + PagerDuty

### 3. Auth bruteforce
- **Tipo:** Custom (Audit log + WAF)
- **Source:** tabela `audit_log` action='auth.login_failed'
- **Trigger:** count > 100/5min mesmo `metadata.email` ou mesmo `ip`
- **Action:** block IP no rate-limit; notify security@grupolivelab.com.br

### 4. Migration failure
- **Tipo:** Issue Alert
- **Filter:** `transaction:db.migration` OR mensagem contém `apply_migrations.js`
- **Trigger:** any failure
- **Action:** critical — PagerDuty + Slack #liveshop-deploys

### 5. TikTok connector error
- **Tipo:** Metric Alert
- **Filter:** `tags.source:tiktok-connector-manager` AND `level:error`
- **Trigger:** error rate > 5/min por 10min
- **Action:** Slack #liveshop-realtime

### 6. Webhook replay attack
- **Tipo:** Issue Alert
- **Filter:** `tags.error_class:webhook_replay`
- **Trigger:** any event
- **Action:** notify security@grupolivelab.com.br

---

## Frontend alerts

### 7. Crash on login
- **Tipo:** Issue Alert
- **Filter:** `tags.screen:login` AND `level:fatal`
- **Trigger:** any event in last 1min
- **Action:** Slack #liveshop-frontend high priority

### 8. Knowledge editor blank
- **Tipo:** Health Check / "no events"
- **Filter:** `tags.screen:admin_article_editor`
- **Trigger:** zero events recebidos por 24h consecutivas após deploy
- **Action:** Slack #liveshop-frontend (provavelmente bundle quebrado)

---

## Setup

1. Setar `SENTRY_DSN` no Railway (env var).
2. Verificar `release` em build do Flutter para correlacionar deploys.
3. Configurar **Inbound Filters** no projeto Sentry para descartar:
   - `error_class:validation` — 4xx esperado, ruído
   - `error_class:auth` — 401 esperado quando token expira
   - `error_class:rbac` — 403 quando user tenta acessar rota errada
   - `error_class:rate_limit` — 429 esperado
4. Configurar `beforeSend` (já feito em `src/app.js`) para scrub de PII.
