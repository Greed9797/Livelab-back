# LiveShop SaaS — Backend API

Backend Node.js + Fastify para a plataforma multi-tenant LiveShop. Gerencia franquias de Live Shop (TikTok Live), pagamentos, contratos, analytics e integrações.

**Stack**: Node.js 20 · Fastify 5 · PostgreSQL (Supabase) · JWT · Asaas/Appmax/TikTok Live · Vitest

---

## Setup local (5 min)

```bash
git clone https://github.com/<org>/liveshop_saas_api-backend.git
cd liveshop_saas_api-backend
cp .env.example .env
# Preencher pelo menos: DATABASE_URL, JWT_SECRET (32+ chars)
npm install
npm run dev          # porta 3001
```

Health check: `GET http://localhost:3001/health`

### ENV vars críticas

| Variável | Descrição | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase) | obrigatório |
| `JWT_SECRET` | min 32 chars, troca a cada vazamento | obrigatório |
| `NODE_ENV` | `development` / `production` / `test` | `development` |
| `PORT` | porta HTTP | `3001` |
| `CORS_ORIGIN` | allowlist origins prod | `*` em dev |
| `APPMAX_APP_ID` + `APPMAX_WEBHOOK_SECRET` | gateway pagamento atual | opcional |
| `TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI` | OAuth TikTok | opcional |
| `BIO_CRM_WEBHOOK_SECRET` | HMAC do webhook bio | opcional |
| `WEBHOOK_REPLAY_PROTECTION` | `true` ativa anti-replay bio-crm | `false` |
| `HEALTH_CHECK_TOKEN` | auth do `/health` | opcional |
| `SENTRY_DSN` | observabilidade (Wave 1 backlog) | opcional |
| `USE_DEV_BYPASS=true` | pula JWT (apenas dev) | NUNCA em prod |

Lista completa em `.env.example`.

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | nodemon, watch `src/`, porta 3001 |
| `npm start` | aplica migrations + inicia servidor (Railway entrypoint) |
| `npx vitest run` | 62 testes unit, ~300ms |
| `npm run test:watch` | watch mode |
| `npm run e2e` | Playwright (atualmente quebrado por config — backlog W2.7) |
| `node apply_migrations.js` | aplica migrations idempotentemente |
| `node create_user.js` | cria usuário pra dev |
| `node seed_users.js` | cria usuários de teste (admin/franqueado/cliente) |

---

## Arquitetura

### Entrypoints

- `src/server.js` — boot: cron, ConnectorManager (TikTok), cleanup, listen
- `src/app.js` — registra plugins (cors, helmet, rate-limit, multipart, db, auth) + rotas

### Plugins

- `src/plugins/db.js` — pool Postgres com 2 decorators:
  - `app.db` — pool-level. Para queries de sistema (auth, health, cron) sem tenant.
  - `app.dbTenant(tenantId)` — connection-level com `set_config('app.tenant_id', ...)`. ⚠️ **Queries DEVEM ter `WHERE tenant_id = $tenant` explícito** porque a role Postgres atual no Supabase tem `BYPASSRLS=true` (ver Runbook → RLS leak).
- `src/plugins/auth.js` — JWT (15min), refresh token (7d, hash SHA256), `app.requirePapel(['gerente'])` RBAC

### Rotas

Cada feature em `src/routes/<feature>.js`. Ver `src/app.js` para lista de imports.

Padrão de rota autenticada multi-tenant:

```js
app.get('/v1/recurso',
  { preHandler: [app.authenticate, app.requirePapel(['franqueado'])] },
  async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `SELECT * FROM tabela WHERE tenant_id = $1::uuid ORDER BY criado_em DESC`,
        [tenant_id]
      )
      return r.rows
    })
  }
)
```

### Webhooks

Endpoints públicos com HMAC + rate-limit. Padrão em `src/routes/webhook_bio_crm.js`:
1. Verifica HMAC `X-Livelab-Signature: sha256=...` via `crypto.timingSafeEqual`
2. (Opcional) Replay protection via timestamp + nonce (toggle `WEBHOOK_REPLAY_PROTECTION=true`)
3. Resposta 401 genérica em qualquer falha (anti-enumeration)
4. Rate limit individual: 30/min via `config: { rateLimit: ... }`

### Real-time

- `src/services/tiktok-connector-manager.js` — gerencia WebcastPushConnection per live ativa
- Reconciliação a cada 60s (diff DB vs in-memory)
- Flush de snapshots a cada 30s para `live_snapshots`
- SSE: `GET /v1/lives/:liveId/stream`

---

## Migrations

Em `migrations/*.sql` ordenadas por número. Lista canônica em `apply_migrations.js`.

```bash
node apply_migrations.js     # aplica pendentes idempotentemente
```

⚠️ Migrations são **append-only** — nunca renomear nem editar uma já aplicada. Para corrigir, criar nova migration.

---

## Testes

```bash
npx vitest run                                # todos os 62 testes
npx vitest run test/routes.regressions.test.js # arquivo específico
```

Padrão: mock `dbTenant`/`authenticate`, `app.inject({ method, url })`, assert response.

**Bug recorrente**: registrar mesma rota duas vezes em `src/routes/*.js` → `FastifyError: Method already declared` que silenciosamente derruba todos os testes. Diagnóstico:
```bash
grep -n "app\.\(get\|post\|patch\|delete\)" src/routes/<arquivo>.js
```

---

## Deploy

**Produção**: Railway auto-deploy on push para `master`.

```bash
git push origin master
# Railway aplica migrations + start (script "start" no package.json)
```

**Status**: https://liveshop-saas-api-production.up.railway.app/health

URLs deprecated: `livelabackend.onrender.com` está MORTA. Não usar.

### Tag release

```bash
git tag -a v1.x.y -m "release notes"
git push origin v1.x.y
```

---

## Runbook (incidentes)

### API down (Railway)

1. Confirmar via UptimeRobot ou `curl https://liveshop-saas-api-production.up.railway.app/health`
2. Railway dashboard → Logs do deploy mais recente
3. Common causes:
   - `DATABASE_URL` inválida → reset Supabase password
   - Migration falha → criar novo migration que reverta o problema
   - Memory limit → upgrade plan ou otimizar query
4. Rollback: Railway dashboard → Deployments → "Redeploy" no commit anterior

### Erro 500 frequente

1. Verificar Sentry (quando configurado — backlog W1.1)
2. `railway logs` filtrar por `ERROR`
3. Hotfix em branch separado, push direto se urgente (master atualmente sem branch protection)

### DB down (Supabase)

1. https://status.supabase.com
2. Read replicas: ainda em backlog (Wave 3)
3. Backup: 7 dias retention default Supabase. Dump diário externo: backlog (W2.13)

### Vazamento de dados (RLS leak — CRITICAL)

⚠️ Role Postgres atual no DATABASE_URL tem **BYPASSRLS=true**. Toda query sem `WHERE tenant_id` explícito vaza dados entre tenants. Ver `~/security-report.md` seção "CRITICAL FINDING (2026-05-07)".

**Hotfix por rota**: adicionar `WHERE tabela.tenant_id = $1::uuid` em qualquer rota que retorna lista.

**Fix definitivo (próxima sprint)**: criar role `liveshop_app` no Supabase Dashboard com `NOBYPASSRLS`, atualizar `DATABASE_URL` no Railway.

---

## Recursos relacionados

- `.env.example` — todas variáveis com descrição
- `STATUS.md` — estado atual, pendências, decisões
- `~/security-report.md` — auditoria de segurança completa
- `~/qa-report-2026-05-07.md` — QA report último ciclo

---

## Convenções

- **Commits**: Conventional Commits — `feat:`, `fix:`, `sec:`, `docs:`, `chore:`, `refactor:`, `test:`
- **PRs**: precisam CI green + 1 review (branch protection backlog W1.6)
- **Branch**: `feat/<descricao>` ou `fix/<descricao>`
- **Tags**: `vMAJOR.MINOR.PATCH[-suffix]`

---

## Score de hardening (atual)

Após Wave 0+1 do plano de prod hardening:
- Security: 91/100 (com RLS leak documentado e hotfix de cabines)
- Observability: 60/100 (CI configurado, Sentry pendente)
- Documentation: 75/100 (este README + STATUS + relatórios)
- Testing: 65/100 (62 unit tests; coverage report e E2E pendentes)

**Backlog priorizado**: ver `~/.claude/plans/crystalline-launching-acorn.md` Wave 2+3.
