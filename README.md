# LiveShop SaaS — Backend API

Backend Node.js + Fastify para a plataforma multi-tenant LiveShop. Gerencia franquias de Live Shop (TikTok Live), pagamentos, contratos, analytics e integrações.

**Stack**: Node.js 22 · Fastify 5 · PostgreSQL · JWT · TikTok Live · Vitest

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
| `TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI` | OAuth TikTok | opcional |
| `BIO_CRM_WEBHOOK_SECRET` | HMAC do webhook bio | opcional |
| `WEBHOOK_REPLAY_PROTECTION` | `true` ativa anti-replay bio-crm | `false` |
| `HEALTH_CHECK_TOKEN` | auth do `/health` | opcional |
| `SENTRY_DSN` | destino de observabilidade Sentry | opcional |
| `USE_DEV_BYPASS=true` | pula JWT (apenas dev) | NUNCA em prod |

Lista completa em `.env.example`.

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | nodemon, watch `src/`, porta 3001 |
| `npm start` | aplica migrations + inicia servidor (Railway entrypoint) |
| `npx vitest run` | suíte Vitest |
| `npm run test:watch` | watch mode |
| `npm run test:integration` | integração com banco PGlite descartável |
| `npm run test:pg` | integração PostgreSQL; configurar banco de teste |
| `node apply_migrations.js` | aplica pendências conforme o ledger transacional |
| `node scripts/seed_users.js` | cria usuários no ambiente de desenvolvimento configurado |

---

## Arquitetura

### Entrypoints

- `src/server.js` — boot: cron, ConnectorManager (TikTok), cleanup, listen
- `src/app.js` — registra plugins (cors, helmet, rate-limit, multipart, db, auth) + rotas

### Plugins

- `src/plugins/db.js` — pool Postgres com 2 decorators:
  - `app.db` — pool-level. Para queries de sistema (auth, health, cron) sem tenant.
  - `app.dbTenant(tenantId)` — connection-level com `set_config('app.tenant_id', ...)`. Inclua filtro explícito de tenant nas queries multi-tenant e confira o papel e a configuração RLS no ambiente de destino.
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
node apply_migrations.js     # banco de teste; aplica somente pendentes do ledger
```

⚠️ Migrations são **append-only** — nunca renomear nem editar uma já aplicada. Para corrigir, criar nova migration.

---

## Testes

```bash
npx vitest run                                # suíte completa
npx vitest run test/routes.regressions.test.js # arquivo específico
```

Padrão: mock `dbTenant`/`authenticate`, `app.inject({ method, url })`, assert response.

**Bug recorrente**: registrar mesma rota duas vezes em `src/routes/*.js` → `FastifyError: Method already declared` que silenciosamente derruba todos os testes. Diagnóstico:
```bash
grep -n "app\.\(get\|post\|patch\|delete\)" src/routes/<arquivo>.js
```

---

## Deploy

**Produção**: Railway monitora a branch `codex/blumenau-operational-fase1`.
Um push nessa branch pode iniciar um deploy. O Railway executa
`node apply_migrations.js` como pre-deploy; consulte o registro publicado antes
de planejar uma alteração ou rollback.

**Status**: https://liveshop-saas-api-production.up.railway.app/health

O deploy verificado em 26/10/2026 está registrado em
[`docs/production-release-2026-10-26.md`](docs/production-release-2026-10-26.md).
O checkout atual pode estar em outra branch e não identifica o código
publicado.

CRM: [`docs/crm-api.md`](docs/crm-api.md). Treinamentos:
[`docs/training-module.md`](docs/training-module.md).

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
   - `DATABASE_URL` inválida → conferir a configuração no gerenciador de segredos, sem expor valores nem alterar credenciais como primeiro diagnóstico
   - Migration falha → criar novo migration que reverta o problema
   - Memory limit → upgrade plan ou otimizar query
4. Consulte o registro da release para o commit anterior e as limitações de
   rollback. Preserve a migration 186 e os dados de treinamento.

### Erro 500 frequente

1. Verificar Sentry, se estiver configurado para o ambiente
2. `railway logs` filtrar por `ERROR`
3. Consulte o fluxo de entrega atual antes de preparar a correção.

### DB down (Supabase)

1. https://status.supabase.com
2. Consulte o status do provedor e a configuração de backup do ambiente.

### Isolamento entre tenants

As rotas multi-tenant devem limitar as consultas ao tenant autenticado e usar
as proteções de acesso definidas pelo backend. Confirme o papel PostgreSQL e o
estado RLS no ambiente afetado antes de tratar configuração histórica como
estado atual.

---

## Recursos relacionados

- `.env.example` — todas variáveis com descrição
- `STATUS.md` — estado atual, pendências, decisões
- `docs/production-release-2026-10-26.md` — deploy verificado e rollback
- `docs/crm-api.md` — rotas e contrato CRM
- `docs/training-module.md` — catálogo e progresso de treinamentos

---

## Convenções

- **Commits**: Conventional Commits — `feat:`, `fix:`, `sec:`, `docs:`, `chore:`, `refactor:`, `test:`
- **PRs**: siga os checks de CI e o processo de revisão configurados no repositório
- **Branch**: `feat/<descricao>` ou `fix/<descricao>`
- **Tags**: `vMAJOR.MINOR.PATCH[-suffix]`

---
