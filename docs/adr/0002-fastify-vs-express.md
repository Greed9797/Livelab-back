# ADR 0002 — Fastify 5 como framework backend (vs Express)

**Status**: Aceito
**Data**: 2026-05-08
**Decisor**: Tech lead

## Contexto

Backend SaaS Node.js 20 + PostgreSQL (Supabase) com:
- ~27 rotas REST autenticadas (multi-tenant via JWT)
- 5+ webhooks externos (Asaas, Appmax, TikTok, bio-crm)
- SSE streaming para lives ao vivo
- TikTok WebcastPushConnection com state in-memory
- Cron jobs (cleanup, billing, snapshot)
- Validação Zod em todos endpoints
- Rate limiting por rota
- Plugins customizados (`auditLog`, `withTenant`, `requirePapel`)

## Decisão

**Fastify 5** com plugin pattern.

## Alternativas consideradas

### Express 4/5

**Prós**:
- Maior community, mais devs
- Ecossistema imenso de middlewares

**Contras**:
- 2-3× mais lento que Fastify em benchmarks reais (req/s)
- Sem schema validation nativo (precisa AJV manual)
- Sem plugin encapsulation — middlewares poluem app global
- Error handling assíncrono pré-Express 5 era manual via `next(err)`
- Logger fraco (precisa Winston/Pino externo)

### NestJS

**Prós**:
- DI container, decorators, opinionated structure
- TypeScript first-class

**Contras**:
- Boilerplate alto pra time pequeno
- Aprendizado mais lento (Angular-like)
- Performance similar ao Fastify mas com mais overhead

### Hono / Elysia

**Prós**:
- Performance ainda melhor que Fastify
- Edge-runtime ready

**Contras**:
- Ecossistema imaturo em 2025-2026
- Sem `@fastify/jwt`, `@fastify/rate-limit`, `@fastify/multipart` equivalentes maduros

## Consequências

### Positivas

- **Performance**: ~50k req/s em hardware comum (Express ~15k)
- **Schema validation**: AJV nativo — `schema: { body, querystring, response }` em cada rota previne SQL injection / malformed input
- **Plugin encapsulation**: cada plugin tem scope próprio (`fp(plugin, { name })`)
- **Logger Pino**: structured logging, ~5× mais rápido que Winston, integra Sentry sem fricção
- **Async error handling** nativo: throws em handlers vão pro `app.setErrorHandler` automaticamente
- **JWT plugin oficial** (`@fastify/jwt`) com cookies + bearer + verify
- **Rate limit plugin** (`@fastify/rate-limit`) com config por rota:
  ```js
  app.post('/v1/webhooks/bio-crm', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, handler)
  ```

### Negativas (aceitas)

- **Pool de devs menor** vs Express — mitigação: API próxima ao Express (req/reply em vez de res, mas familiar)
- **Plugin async ordering** — `await app.register(...)` necessário em sequência crítica (db antes de auth antes de routes)
- **Schema strict mode em Fastify 5** quebra alguns validators legacy (vimos em `analytics.js` com `format: 'date'` que precisava `ajv-formats`). Mitigação: validação manual via Zod onde AJV format-strict é problema
- **Webhooks rawBody** precisa `addContentTypeParser` custom para HMAC signature verification

## Implementação

- **Boot**: `src/server.js` → `buildApp()` → `app.listen({ host: '0.0.0.0', port })`
- **Plugins core** (em `src/plugins/`):
  - `db.js` — pool Postgres + decorator `app.withTenant(tenantId, fn)`
  - `auth.js` — JWT verify + `app.requirePapel([...])` RBAC
  - `audit_log.js` — `app.audit.log(req, info)` middleware com PII scrub
- **Rotas** em `src/routes/<feature>.js` registradas via `app.register(routes)`
- **Error handler global** em `src/app.js` — Sentry capture 5xx + sanitize 4xx response
- **Validation**: Zod em vez de AJV pra body (mais ergonômico) — manual `safeParse → reply.code(400)`

## Padrão estabelecido

Toda rota multi-tenant:

```js
app.get('/v1/recurso',
  { preHandler: [app.authenticate, app.requirePapel(['franqueado'])] },
  async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `SELECT * FROM tabela WHERE tenant_id = $1::uuid ORDER BY criado_em DESC`,
        [tenant_id]  // ⚠️ EXPLÍCITO — RLS Postgres role tem BYPASSRLS
      )
      return r.rows
    })
  }
)
```

## Revisão

Re-avaliar se:
- Performance virar bloqueador (>50k req/s) — considerar Hono
- Time chegar >10 devs — considerar NestJS pra estrutura
- Edge runtime virar requisito (latência global) — Hono em Cloudflare Workers

## Referências

- `src/app.js` — composição de plugins
- `src/plugins/db.js` — withTenant pattern
- `src/plugins/auth.js` — JWT + RBAC
- ADR 0003 — RLS strategy (depende deste)
