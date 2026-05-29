# TikTok Live + Shop API Integration — Spec Corrigida

**Data:** 2026-04-12
**Projeto:** LiveShop SaaS Backend (`liveshop_saas_api-backend-`)
**Stack:** Node.js 20+ · Fastify 5 · PostgreSQL (Supabase) · node-cron 4 · tiktok-live-connector 2.1.1-beta1
**Status:** Spec aprovada, pronta para Plano de Implementação

## Sumário Executivo

Integrar TikTok Live (real-time via WebSocket) e TikTok Shop Partner API (pedidos via REST/OAuth) ao backend LiveShop, alimentando o fluxo de royalties/comissões existente **sem quebrar o modelo atual** de `lives`, `live_snapshots` e o `billing_engine` quinzenal.

**Princípios de design** (baseados na auditoria prévia contra o schema real):

1. **Reutilizar o que já existe.** A tabela `lives`, `live_snapshots`, a coluna `comissao_calculada`, o `billing_engine`, o `tiktok-connector-manager.js` e as funções de `services/asaas.js` ficam como estão. Esta spec **estende** o que falta, não reescreve.
2. **Não duplicar fontes de verdade.** GMV = `lives.fat_gerado`. Comissão/royalty = `lives.comissao_calculada`. Peak viewers, likes, comments = agregados de `live_snapshots`. Tokens Shop = `tiktok_shop_tokens` (nova tabela, substitui colunas soltas em `tenants`).
3. **Não criar boletos por-live.** O `billing_engine` existente já roda nos dias 1 e 16 agregando `comissao_calculada` das lives encerradas. Shop sync só **preenche** `fat_gerado` e `comissao_calculada`; o faturamento continua em lote.
4. **Fail-safe no connector.** TikTok Live Connector é engenharia reversa e quebra periodicamente. Precisa circuit breaker e alerta — a integração **não pode** ser o único caminho de cobrança.
5. **Gate regional antes da Fase 2.** TikTok Shop Partner API pode não estar aberto no BR para a conta da Unikids. Validar acesso **antes** de escrever qualquer código de Shop API.

## 1. Escopo

### 1.1 Dentro do escopo

- Conexão real-time com lives do TikTok (viewers, chat, likes, gifts, shares)
- Canal SSE separado para eventos individuais de chat/gift (mantendo o canal snapshot existente)
- Circuit breaker + alerta de saúde do connector
- Sincronização de pedidos da TikTok Shop Partner API por tenant
- OAuth de Shop por tenant (franqueado conecta a loja)
- Armazenamento de pedidos em `tiktok_shop_orders` para auditoria
- Atualização de `lives.fat_gerado` e `lives.comissao_calculada` a partir dos pedidos sincronizados
- Migração gradual dos tokens TikTok de `tenants.tiktok_*` → `tiktok_shop_tokens`

### 1.2 Fora do escopo

- Tabela `royalties` separada (descartada — `lives.comissao_calculada` + billing_engine já cobre)
- Boletos por-live (descartado — billing_engine quinzenal permanece)
- Novo arquivo `services/tiktok-live.js` (descartado — estender `tiktok-connector-manager.js`)
- Decorator `app.asaasService` (não existe e não será criado — importar funções direto de `services/asaas.js`)
- Rotas manuais de `connect/disconnect` do Live Connector (o reconciliation cron faz isso automaticamente; só endpoint de debug)
- Tabela `tenant_settings` (não existe; configs ficam em `tenants.configuracoes_json` JSONB)

## 2. Schema — Migrations

### 2.1 Migration 027 — `tiktok_shop_tokens` (nova tabela)

```sql
-- migrations/027_tiktok_shop_tokens.sql
CREATE TABLE IF NOT EXISTS tiktok_shop_tokens (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL REFERENCES tenants(id),
  tiktok_shop_id             TEXT NOT NULL,   -- seller_id / open_id retornado pela Shop API
  tiktok_seller_name         TEXT,
  access_token               TEXT NOT NULL,
  refresh_token              TEXT NOT NULL,
  access_token_expires_at    TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at   TIMESTAMPTZ NOT NULL,
  scopes                     TEXT[],
  region                     TEXT NOT NULL DEFAULT 'BR',
  is_active                  BOOLEAN NOT NULL DEFAULT true,
  last_sync_at               TIMESTAMPTZ,
  last_error                 TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, tiktok_shop_id)
);

CREATE INDEX idx_tiktok_shop_tokens_tenant ON tiktok_shop_tokens(tenant_id);
CREATE INDEX idx_tiktok_shop_tokens_active ON tiktok_shop_tokens(is_active) WHERE is_active = true;

ALTER TABLE tiktok_shop_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tiktok_shop_tokens_tenant ON tiktok_shop_tokens
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**Notas:**
- RLS usa `, true` (padrão do projeto, evita erro em queries pool-level)
- `region` inicial `'BR'` — a integração só considera BR inicialmente (ver gate regional §6.1)
- `last_sync_at` e `last_error` dão observabilidade sem precisar tabela de log
- `is_active` permite soft-disable sem perder credenciais

### 2.2 Migration 028 — `tiktok_shop_orders` (nova tabela)

```sql
-- migrations/028_tiktok_shop_orders.sql
CREATE TABLE IF NOT EXISTS tiktok_shop_orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  tiktok_order_id       TEXT NOT NULL,
  tiktok_shop_id        TEXT NOT NULL,
  live_id               UUID REFERENCES lives(id) ON DELETE SET NULL,
  status                TEXT NOT NULL,   -- UNPAID, AWAITING_SHIPMENT, SHIPPED, DELIVERED, COMPLETED, CANCELLED, etc.
  total_amount          NUMERIC(15,2) NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'BRL',
  buyer_username        TEXT,
  items_count           INTEGER NOT NULL DEFAULT 1,
  order_created_at      TIMESTAMPTZ,
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  counts_in_gmv         BOOLEAN NOT NULL DEFAULT false,  -- só true se status in ('COMPLETED','DELIVERED')
  raw_data              JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, tiktok_order_id)
);

CREATE INDEX idx_tiktok_orders_tenant        ON tiktok_shop_orders(tenant_id);
CREATE INDEX idx_tiktok_orders_live          ON tiktok_shop_orders(live_id)             WHERE live_id IS NOT NULL;
CREATE INDEX idx_tiktok_orders_counts_gmv    ON tiktok_shop_orders(tenant_id, live_id)  WHERE counts_in_gmv = true;
CREATE INDEX idx_tiktok_orders_created       ON tiktok_shop_orders(order_created_at);

ALTER TABLE tiktok_shop_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tiktok_shop_orders_tenant ON tiktok_shop_orders
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

**Decisões:**
- FK aponta `lives(id)` (não `live_sessions` — tabela inexistente). `ON DELETE SET NULL` preserva auditoria de pedidos mesmo se a live for deletada.
- `counts_in_gmv BOOLEAN` materializa a decisão "este pedido conta no faturamento?" em vez de filtrar por status toda vez. Calculado no momento do upsert.
- `total_amount NUMERIC(15,2)` segue a convenção do projeto (`fat_gerado`, `comissao_calculada` usam `15,2`, não `12,2`).
- `raw_data` guarda payload completo pra debug e reprocessamento.

### 2.3 Migration 029 — Extensões em `lives` (mínimas)

```sql
-- migrations/029_lives_tiktok_fields.sql
-- Só o que NÃO pode ser derivado de live_snapshots ou contratos.

-- 1. Room ID do TikTok (metadado necessário para reconexão e link pro live real)
ALTER TABLE lives ADD COLUMN IF NOT EXISTS tiktok_room_id TEXT;

-- 2. Cache denormalizado de métricas finais (preenchido no stopConnector pra evitar
--    agregação de snapshots no dashboard). Opcional mas acelera reads.
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_peak_viewers      INTEGER;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_likes       BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_comments    BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_shares      BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_gifts_diamonds    BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_orders_count      INTEGER;
```

**O que NÃO foi adicionado** (com justificativa):

| Coluna proposta | Status | Por quê |
|---|---|---|
| `tiktok_username` | ❌ | Já existe em `contratos.tiktok_username` (migration 021). Username é do contrato do cliente, não da live. O connector manager atual faz JOIN com contratos — manter. |
| `gmv_total` | ❌ | Usar `lives.fat_gerado` que já existe e tem o mesmo significado. |
| `royalty_amount` | ❌ | Usar `lives.comissao_calculada` que já existe. |
| `royalty_percentage` | ❌ | Fica em `tenants.configuracoes_json->>'royalty_percentage'` (JSONB existente). Default 10. |
| `peak_viewers`, `total_likes`, etc. (sem prefix) | ❌ | Derivável de `SELECT MAX(total_viewers), MAX(likes_count) FROM live_snapshots WHERE live_id = ?`. Os `final_*` adicionados acima são **cache** opcional. |

### 2.4 Migration 030 — `royalties` → DESCARTADA

**Decisão:** o fluxo existente de `lives.comissao_calculada` + `billing_engine.js` já cobre o caso. Adicionar tabela separada gera:
- Double source of truth (agregar por cliente no billing vs. por-live no royalties)
- Duplicação de lógica Asaas
- Conflito com o tipo de boleto `'royalties'` que já é gerado pelo billing engine (`billing_engine.js:106`)

### 2.5 Migration 031 — Backfill dos tokens existentes de `tenants` → `tiktok_shop_tokens`

```sql
-- migrations/031_migrate_tenants_tiktok_to_shop_tokens.sql
-- Move credenciais TikTok que hoje estão soltas em `tenants` para a nova tabela.
-- Roda DEPOIS que o novo código (leitura de tiktok_shop_tokens) já está deployado.

INSERT INTO tiktok_shop_tokens
  (tenant_id, tiktok_shop_id, access_token, refresh_token,
   access_token_expires_at, refresh_token_expires_at, scopes, region, is_active)
SELECT
  id,
  COALESCE(tiktok_shop_id, 'legacy-' || id::text),
  tiktok_access_token,
  '',                                            -- refresh_token: desconhecido, forçará reconectar
  NOW() - INTERVAL '1 second',                   -- marca como expirado → força refresh/reconnect
  NOW() - INTERVAL '1 second',
  ARRAY[]::text[],
  'BR',
  (tiktok_access_token IS NOT NULL)
FROM tenants
WHERE tiktok_access_token IS NOT NULL
ON CONFLICT (tenant_id, tiktok_shop_id) DO NOTHING;
```

**Nota:** backfill **intencionalmente** marca tokens como expirados. Os tokens atuais em `tenants.tiktok_access_token` foram gerados pelo callback mock (`routes/tiktok.js:82-88` — `tk_live_${random}`), então nenhum deles é real. Forçar reconectar é safer.

### 2.6 Migration 032 — Drop das colunas antigas em `tenants` (deferred)

```sql
-- migrations/032_drop_tenants_tiktok_columns.sql
-- RODAR SOMENTE depois que:
--   1. Código nunca mais lê de tenants.tiktok_access_token etc.
--   2. Frontend foi deployado usando as novas rotas
--   3. 30 dias passaram sem incidentes
-- Checklist no README antes de rodar.

ALTER TABLE tenants DROP COLUMN IF EXISTS tiktok_access_token;
ALTER TABLE tenants DROP COLUMN IF EXISTS tiktok_shop_id;
-- Não droppar: configuracoes_json (usado por royalty_percentage)
-- Não droppar: tiktok_refresh_token / tiktok_token_expires_at / tiktok_user_id
--   (pode não existir; foram adicionadas ad-hoc pela rota atual sem migration)
```

**Não executar na Fase 1.** Essa migration fica pendente até conferir que todo leitor migrou.

## 3. Serviços

### 3.1 Estender `src/services/tiktok-connector-manager.js` (não criar novo)

**Motivação:** já é um singleton funcional, bem testado (9 testes passando em `test/tiktok-connector-manager.test.js`), integrado ao `server.js`, com reconciliation cron. Criar um `services/tiktok-live.js` paralelo geraria dois managers disputando o mesmo WebSocket por live.

**Eventos novos a hookar** (em `startConnector`, junto dos existentes `roomUser`, `like`, `social`, `chat`):

```javascript
// GIFT — diamantes monetizáveis
connection.on('gift', (data) => {
  // TikTok gift types:
  //   giftType === 1 + repeatEnd === true  → streak gift finalizado (conta multiplicado)
  //   giftType === 1 + repeatEnd === false → streak em progresso (ignorar, chega no final)
  //   giftType !== 1                       → gift único (conta imediato)
  if (data.giftType === 1 && !data.repeatEnd) return

  const multiplier = data.giftType === 1 ? (data.repeatCount ?? 1) : 1
  const diamonds = (data.diamondCount ?? 0) * multiplier

  state.gifts_diamonds += diamonds
  state.dirty = true

  // Emit evento individual (novo canal — ver §3.2)
  _emitter.emit(`event:${liveId}`, {
    type: 'gift',
    user: data.uniqueId,
    giftName: data.giftName,
    diamonds,
    repeatCount: data.repeatCount ?? 1,
    ts: Date.now(),
  })
})

// SHARE — share da live
connection.on('share', (data) => {
  state.shares_count += 1
  state.dirty = true
  _emitter.emit(`event:${liveId}`, {
    type: 'share',
    user: data.uniqueId,
    ts: Date.now(),
  })
})

// STREAM END — TikTok finalizou a live (não é a mesma coisa que disconnected)
connection.on('streamEnd', () => {
  _log?.info({ liveId }, 'tiktokManager: streamEnd recebido do TikTok')
  stopConnector(liveId).catch(err => {
    _log?.error({ err, liveId }, 'tiktokManager: erro ao parar connector após streamEnd')
  })
})
```

**Emit de eventos individuais no `_handleChat` existente:**

```javascript
// Adicionar no _handleChat, depois do state.dirty = true:
_emitter.emit(`event:${liveId}`, {
  type: 'chat',
  user: data.uniqueId,
  comment: data.comment,
  ts: Date.now(),
})
```

**Extensão do `state` inicial:**

```javascript
const state = {
  viewer_count: 0,
  total_viewers: 0,
  total_orders: 0,
  gmv: 0,
  likes_count: 0,
  comments_count: 0,
  gifts_diamonds: 0,      // NOVO
  shares_count: 0,        // NOVO
  dirty: false,
  flushing: false,
  lastFlush: Date.now(),
}
```

**Extensão do `_flushToDb`** — incluir colunas novas no INSERT de `live_snapshots`:

```sql
-- Requer ALTER TABLE live_snapshots ADD COLUMN gifts_diamonds BIGINT DEFAULT 0, shares_count BIGINT DEFAULT 0
```

Adicionar isso na Migration 029:
```sql
ALTER TABLE live_snapshots ADD COLUMN IF NOT EXISTS gifts_diamonds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE live_snapshots ADD COLUMN IF NOT EXISTS shares_count   BIGINT NOT NULL DEFAULT 0;
```

**Extensão do `stopConnector`** — preencher cache de `final_*` em `lives`:

```javascript
export async function stopConnector(liveId) {
  const entry = _liveMap.get(liveId)
  if (!entry) return

  clearInterval(entry.flushTimer)
  await _flushToDb(liveId, entry)

  // NOVO: preencher cache denormalizado em `lives`
  try {
    await _db.query(`
      UPDATE lives
      SET final_peak_viewers   = $1,
          final_total_likes    = $2,
          final_total_comments = $3,
          final_total_shares   = $4,
          final_gifts_diamonds = $5,
          final_orders_count   = $6
      WHERE id = $7
    `, [
      entry.state.total_viewers,
      entry.state.likes_count,
      entry.state.comments_count,
      entry.state.shares_count,
      entry.state.gifts_diamonds,
      entry.state.total_orders,
      liveId,
    ])
  } catch (err) {
    _log?.error({ err, liveId }, 'tiktokManager: falha ao atualizar final_* em lives')
  }

  try { await entry.connection.disconnect() } catch (err) {
    _log?.warn({ err, liveId }, 'tiktokManager: erro ao desconectar connector')
  }

  _liveMap.delete(liveId)
  _log?.info({ liveId }, 'tiktokManager: connector parado')
}
```

### 3.2 Novo canal SSE — `event:${liveId}`

**Modelo decidido:** manter o canal `snapshot:${liveId}` (flush 30s, métricas agregadas) **e** adicionar um segundo canal `event:${liveId}` (evento-a-evento, para chat/gift/share em tempo real). São publicados pelo mesmo EventEmitter singleton já existente.

**Nova rota** em `src/routes/tiktok.js` (ou novo `src/routes/live_events.js`):

```javascript
// GET /v1/lives/:liveId/events — SSE para chat/gift/share individuais
app.get('/v1/lives/:liveId/events', {
  preHandler: app.requirePapel(['franqueado', 'franqueador_master'])
}, async (request, reply) => {
  const { tenant_id } = request.user
  const { liveId } = request.params

  // Validar ownership e status
  const { rows } = await app.db.query(
    `SELECT id FROM lives WHERE id = $1 AND tenant_id = $2 AND status = 'em_andamento'`,
    [liveId, tenant_id]
  )
  if (rows.length === 0) {
    return reply.code(404).send({ error: 'Live não encontrada ou não está ao vivo' })
  }

  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.flushHeaders()

  const emitter = getEmitter()
  const eventName = `event:${liveId}`
  const handler = (evt) => {
    if (!reply.raw.destroyed) {
      reply.raw.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`)
    }
  }
  emitter.on(eventName, handler)

  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(': keep-alive\n\n')
  }, 15_000)

  await new Promise((resolve) => {
    request.raw.once('close', resolve)
    request.raw.once('error', resolve)
  })

  emitter.off(eventName, handler)
  clearInterval(heartbeat)
  try { reply.raw.end() } catch {}
})
```

**Front-end:** mantém consumindo `/v1/lives/:liveId/stream` para o dashboard de métricas agregadas. Abre um segundo `EventSource` em `/v1/lives/:liveId/events` se quiser mostrar chat/gifts ao vivo.

### 3.3 Circuit breaker no connector manager

**Problema:** `tiktok-live-connector` é engenharia reversa e quebra periodicamente. Hoje `connection.on('error')` só loga warn (`tiktok-connector-manager.js:159-161`).

**Adicionar ao estado do connector:**

```javascript
const state = {
  // ... campos existentes
  errorCount: 0,          // contador nas últimas N min
  errorWindowStart: Date.now(),
  circuitOpen: false,
}

const CIRCUIT_BREAKER_THRESHOLD = Number(process.env.TIKTOK_CB_THRESHOLD ?? 5)
const CIRCUIT_BREAKER_WINDOW_MS = Number(process.env.TIKTOK_CB_WINDOW_MS ?? 5 * 60_000) // 5 min
```

**No handler `error`:**

```javascript
connection.on('error', (err) => {
  _log?.warn({ err, liveId, username }, 'tiktokManager: erro no connector')

  // Circuit breaker: contar erros em janela deslizante
  const now = Date.now()
  if (now - state.errorWindowStart > CIRCUIT_BREAKER_WINDOW_MS) {
    state.errorWindowStart = now
    state.errorCount = 0
  }
  state.errorCount += 1

  if (state.errorCount >= CIRCUIT_BREAKER_THRESHOLD && !state.circuitOpen) {
    state.circuitOpen = true
    _log?.error({ liveId, username, errorCount: state.errorCount },
      'tiktokManager: CIRCUIT BREAKER OPEN — connector em estado degradado')
    _emitter.emit(`health:${liveId}`, {
      type: 'connector_degraded',
      liveId,
      errorCount: state.errorCount,
      ts: now,
    })
    // Marcar no banco pra alertar no frontend
    _db.query(
      `UPDATE lives SET tiktok_connector_status = 'degraded' WHERE id = $1`,
      [liveId]
    ).catch(() => {})
  }
})
```

**Nova coluna em `lives`** (adicionar em Migration 029):

```sql
ALTER TABLE lives ADD COLUMN IF NOT EXISTS tiktok_connector_status TEXT DEFAULT 'ok'
  CHECK (tiktok_connector_status IN ('ok', 'degraded', 'offline'));
```

**Frontend:** lê `lives.tiktok_connector_status` junto com o resto dos dados da live. Se `degraded` ou `offline`, mostra badge "TikTok integration offline" e permite input manual de GMV pelo apresentador (ver §6.1).

### 3.4 Novo `src/services/tiktok-shop.js`

**Responsabilidade:** cliente HTTP para TikTok Shop Partner API. OAuth, signing, orders, refresh.

```javascript
// src/services/tiktok-shop.js
import crypto from 'node:crypto'

// GATE REGIONAL: antes de merger esse arquivo na main, validar que:
// 1. TikTok Shop BR tem Partner API disponível na região
// 2. A conta do cliente (Unikids) tem acesso ao Partner Center BR
// 3. O endpoint correto é realmente open-api.tiktokglobalshop.com ou se BR usa outro
// Ver §6.1 da spec.
const TIKTOK_SHOP_BASE = process.env.TIKTOK_SHOP_BASE_URL ?? 'https://open-api.tiktokglobalshop.com'

// Status que contam no GMV (configurável via env pra ajuste rápido)
const GMV_COUNTING_STATUSES = new Set(
  (process.env.TIKTOK_GMV_STATUSES ?? 'COMPLETED,DELIVERED').split(',')
)

export function createTikTokShopClient({ appKey, appSecret, log }) {
  if (!appKey || !appSecret) {
    throw new Error('TIKTOK_SHOP_APP_KEY e TIKTOK_SHOP_APP_SECRET obrigatórios')
  }

  // ── Request signing (HMAC-SHA256) ───────────────────────────────────────
  function _sign(path, params, body = '') {
    const sortedParams = Object.keys(params)
      .sort()
      .filter(k => k !== 'sign' && k !== 'access_token')
      .map(k => `${k}${params[k]}`)
      .join('')
    const baseString = `${appSecret}${path}${sortedParams}${body}${appSecret}`
    return crypto.createHmac('sha256', appSecret).update(baseString).digest('hex')
  }

  async function _request(path, accessToken, queryParams = {}, body = null) {
    const timestamp = Math.floor(Date.now() / 1000)
    const params = {
      app_key: appKey,
      timestamp: String(timestamp),
      ...queryParams,
    }
    const bodyStr = body ? JSON.stringify(body) : ''
    params.sign = _sign(path, params, bodyStr)
    if (accessToken) params.access_token = accessToken

    const url = `${TIKTOK_SHOP_BASE}${path}?${new URLSearchParams(params)}`
    const options = {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
    if (body) options.body = bodyStr

    let res
    try {
      res = await fetch(url, options)
    } catch (err) {
      throw new Error(`TikTok Shop rede indisponível: ${err.message}`)
    }

    const data = await res.json().catch(() => ({}))
    if (data.code !== 0) {
      const msg = data.message ?? `HTTP ${res.status}`
      log?.error({ path, code: data.code, msg }, 'TikTok Shop API error')
      const err = new Error(`TikTok Shop: ${msg}`)
      err.code = data.code
      throw err
    }
    return data.data
  }

  // ── OAuth ───────────────────────────────────────────────────────────────
  function getAuthUrl(signedState) {
    const params = new URLSearchParams({ app_key: appKey, state: signedState })
    return `https://auth.tiktok-shops.com/oauth/authorize?${params}`
  }

  async function exchangeCodeForToken(code) {
    return _request('/api/v2/token/get', null, {
      app_secret: appSecret,
      auth_code: code,
      grant_type: 'authorized_code',
    })
  }

  async function refreshAccessToken(refreshToken) {
    return _request('/api/v2/token/refresh', null, {
      app_secret: appSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
  }

  // ── Orders ──────────────────────────────────────────────────────────────
  async function getOrders(accessToken, { startDate, endDate, pageSize = 50, cursor = '' }) {
    const body = {
      create_time_from: Math.floor(new Date(startDate).getTime() / 1000),
      create_time_to: Math.floor(new Date(endDate).getTime() / 1000),
      page_size: pageSize,
      ...(cursor && { cursor }),
    }
    return _request('/api/orders/search', accessToken, {}, body)
  }

  return {
    getAuthUrl,
    exchangeCodeForToken,
    refreshAccessToken,
    getOrders,
    _GMV_COUNTING_STATUSES: GMV_COUNTING_STATUSES,  // exposed pra testes
  }
}
```

**Decisões:**
- Factory function, não class — alinha com o padrão de `services/asaas.js` (exports funcionais)
- Sem decorator no Fastify (`app.tiktokShop`) — import direto nos callers
- `GMV_COUNTING_STATUSES` controla quais status contam no faturamento (configurável via env)
- `_request` centraliza signing/error handling
- Não tem `syncOrders` aqui — isso fica no job (§4.1) que tem acesso ao DB

**CSRF signed state:**

```javascript
// Helper pra geração de state assinado (evita CSRF)
// Usar HMAC com JWT_SECRET existente
export function createSignedState({ tenantId, nonce }) {
  const payload = `${tenantId}:${nonce}:${Date.now()}`
  const sig = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 16)
  return `${payload}:${sig}`
}

export function verifySignedState(state, maxAgeMs = 10 * 60_000) {
  const parts = state.split(':')
  if (parts.length !== 4) return null
  const [tenantId, nonce, tsStr, sig] = parts
  const payload = `${tenantId}:${nonce}:${tsStr}`
  const expected = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 16)
  if (sig !== expected) return null
  const ts = Number(tsStr)
  if (Date.now() - ts > maxAgeMs) return null
  return { tenantId, nonce, ts }
}
```

### 3.5 Sem `src/services/royalty-calculator.js`

**Descartado.** O `billing_engine.js` existente já agrega `comissao_calculada` e gera boletos em lote. Esta integração só precisa **preencher** `lives.fat_gerado` e `lives.comissao_calculada` — o que é feito pelo job de sync (§4.1).

## 4. Jobs / Cron

### 4.1 Novo `src/jobs/tiktok-shop-sync.js`

**Responsabilidade:**
1. Para cada tenant com token ativo: sincronizar pedidos das últimas 24h (ou desde `last_sync_at`)
2. Upsert em `tiktok_shop_orders` com `counts_in_gmv` resolvido pelo status
3. Agregar `SUM(total_amount) WHERE counts_in_gmv = true` por live → `lives.fat_gerado`
4. Calcular `lives.comissao_calculada = fat_gerado * royalty_percentage / 100`
5. Refresh automático de token quando `access_token_expires_at < now() + 1h`

**Rate limiting:**
- Processar tenants **em série**, não em paralelo
- Delay de 200ms entre tenants
- Retry com exponential backoff em erro de rate limit da API (código específico da TikTok)
- Usar `p-queue` ou controle manual — **não** precisa de dependência nova se o delay for simples

**Refresh de token:** **cron separado**, a cada 6h (`0 */6 * * *`). Verifica quais tokens vão expirar nas próximas 12h e refresh proativo. **Não misturar com sync de orders** — separa responsabilidades e facilita observabilidade.

**Estrutura do arquivo:**

```javascript
// src/jobs/tiktok-shop-sync.js
import { createTikTokShopClient } from '../services/tiktok-shop.js'

const SYNC_THROTTLE_MS = Number(process.env.TIKTOK_SYNC_THROTTLE_MS ?? 200)

export async function syncAllShopOrders(app) {
  const client = createTikTokShopClient({
    appKey: process.env.TIKTOK_SHOP_APP_KEY,
    appSecret: process.env.TIKTOK_SHOP_APP_SECRET,
    log: app.log,
  })

  const { rows: tokens } = await app.db.query(
    `SELECT id, tenant_id, tiktok_shop_id, access_token, refresh_token,
            access_token_expires_at, last_sync_at
       FROM tiktok_shop_tokens
      WHERE is_active = true
      ORDER BY last_sync_at NULLS FIRST`
  )

  for (const token of tokens) {
    try {
      // Refresh se expirado (janela de 1h)
      let accessToken = token.access_token
      if (new Date(token.access_token_expires_at) < new Date(Date.now() + 60 * 60_000)) {
        const refreshed = await client.refreshAccessToken(token.refresh_token)
        accessToken = refreshed.access_token
        await _saveRefreshedToken(app, token.id, refreshed)
      }

      const result = await _syncTenantOrders(app, client, token, accessToken)

      await app.db.query(
        `UPDATE tiktok_shop_tokens
            SET last_sync_at = NOW(), last_error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [token.id]
      )

      app.log.info({ tenantId: token.tenant_id, ...result }, 'tiktok-shop-sync: tenant ok')
    } catch (err) {
      app.log.error({ err, tenantId: token.tenant_id }, 'tiktok-shop-sync: falha')
      await app.db.query(
        `UPDATE tiktok_shop_tokens SET last_error = $1, updated_at = NOW() WHERE id = $2`,
        [err.message.slice(0, 500), token.id]
      )
    }

    // Throttle: 200ms entre tenants (evita rate limit)
    await new Promise(r => setTimeout(r, SYNC_THROTTLE_MS))
  }
}

async function _syncTenantOrders(app, client, token, accessToken) {
  const startDate = token.last_sync_at ?? new Date(Date.now() - 24 * 60 * 60_000)
  const endDate = new Date()

  let cursor = ''
  let totalSynced = 0
  let totalCountingGmv = 0

  do {
    const res = await client.getOrders(accessToken, {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      cursor,
    })
    const orders = res.order_list ?? []

    for (const order of orders) {
      const countsInGmv = client._GMV_COUNTING_STATUSES.has(order.order_status)
      const liveId = await _matchOrderToLive(app, token.tenant_id, order)

      await app.db.query(`
        INSERT INTO tiktok_shop_orders
          (tenant_id, tiktok_order_id, tiktok_shop_id, live_id, status,
           total_amount, currency, buyer_username, items_count,
           order_created_at, counts_in_gmv, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), $11, $12::jsonb)
        ON CONFLICT (tenant_id, tiktok_order_id) DO UPDATE SET
          status = EXCLUDED.status,
          total_amount = EXCLUDED.total_amount,
          counts_in_gmv = EXCLUDED.counts_in_gmv,
          live_id = COALESCE(tiktok_shop_orders.live_id, EXCLUDED.live_id),
          synced_at = NOW(),
          raw_data = EXCLUDED.raw_data
      `, [
        token.tenant_id,
        order.order_id,
        token.tiktok_shop_id,
        liveId,
        order.order_status,
        parseFloat(order.payment?.total_amount ?? 0),
        order.payment?.currency ?? 'BRL',
        order.buyer?.username ?? null,
        order.line_items?.length ?? 1,
        order.create_time,
        countsInGmv,
        JSON.stringify(order),
      ])

      totalSynced++
      if (countsInGmv) totalCountingGmv++
    }

    cursor = res.next_cursor ?? ''
  } while (cursor)

  // Agregar fat_gerado por live e recalcular comissao_calculada
  await _aggregateLiveGmv(app, token.tenant_id)

  return { totalSynced, totalCountingGmv }
}

// Tenta associar o pedido a uma live específica via buyer no chat + proximidade temporal.
// Heurística inicial: se há uma live 'em_andamento' do mesmo tenant no momento do pedido,
// associa com ela. Futuro: matching mais rico via events emitidos do chat.
async function _matchOrderToLive(app, tenantId, order) {
  const orderTs = order.create_time * 1000
  const { rows } = await app.db.query(`
    SELECT id FROM lives
    WHERE tenant_id = $1
      AND status IN ('em_andamento', 'encerrada')
      AND iniciado_em <= to_timestamp($2)
      AND (encerrado_em IS NULL OR encerrado_em >= to_timestamp($2))
    ORDER BY iniciado_em DESC
    LIMIT 1
  `, [tenantId, order.create_time])
  return rows[0]?.id ?? null
}

async function _aggregateLiveGmv(app, tenantId) {
  // Para cada live do tenant com orders counting_in_gmv, atualizar fat_gerado e comissao_calculada.
  // royalty_percentage vem de tenants.configuracoes_json, default 10.
  await app.db.query(`
    WITH live_gmv AS (
      SELECT live_id, SUM(total_amount) AS gmv
      FROM tiktok_shop_orders
      WHERE tenant_id = $1 AND counts_in_gmv = true AND live_id IS NOT NULL
      GROUP BY live_id
    ),
    tenant_pct AS (
      SELECT COALESCE(
        (configuracoes_json->>'royalty_percentage')::numeric,
        10.0
      ) AS pct
      FROM tenants WHERE id = $1
    )
    UPDATE lives l
       SET fat_gerado         = lg.gmv,
           comissao_calculada = lg.gmv * (SELECT pct FROM tenant_pct) / 100
      FROM live_gmv lg
     WHERE l.id = lg.live_id
       AND l.tenant_id = $1
       AND l.faturado_em IS NULL   -- não mexer em lives já faturadas
  `, [tenantId])
}

async function _saveRefreshedToken(app, tokenId, refreshed) {
  await app.db.query(`
    UPDATE tiktok_shop_tokens
       SET access_token = $1,
           refresh_token = $2,
           access_token_expires_at = NOW() + ($3 || ' seconds')::interval,
           refresh_token_expires_at = NOW() + ($4 || ' seconds')::interval,
           updated_at = NOW()
     WHERE id = $5
  `, [
    refreshed.access_token,
    refreshed.refresh_token,
    String(refreshed.access_token_expire_in ?? 86400),
    String(refreshed.refresh_token_expire_in ?? 604800),
    tokenId,
  ])
}
```

**Pontos importantes:**
- Não mexe em lives com `faturado_em IS NOT NULL` (preserva auditoria do que foi cobrado)
- `_matchOrderToLive` começa com heurística simples (live ativa no momento). Versões futuras podem matchear via eventos de chat.
- Error handling por-tenant: uma falha em um tenant não bloqueia os outros
- Persistência do último erro para debug

### 4.2 Registro no `src/server.js`

```javascript
// src/server.js — adições
import { syncAllShopOrders } from './jobs/tiktok-shop-sync.js'
import { refreshExpiringTokens } from './jobs/tiktok-shop-token-refresh.js'

// Sync de pedidos a cada 5 min
cron.schedule('*/5 * * * *', async () => {
  try {
    await syncAllShopOrders(app)
  } catch (err) {
    app.log.error({ err }, 'tiktok-shop-sync falhou')
  }
})

// Refresh de tokens expirando a cada 6h
cron.schedule('0 */6 * * *', async () => {
  try {
    await refreshExpiringTokens(app)
  } catch (err) {
    app.log.error({ err }, 'tiktok-shop-token-refresh falhou')
  }
})
```

### 4.3 Keyword detection flag

**Problema (§D2 da auditoria original):** `tiktok-connector-manager._handleChat()` detecta "quero X" no chat e incrementa `state.total_orders` + `state.gmv` via `live_products` match. Se Shop API real começar a preencher `tiktok_shop_orders`, haverá double-counting.

**Solução:** flag por tenant em `tenants.configuracoes_json`:

```javascript
// Dentro de _handleChat, logo no começo:
async function _handleChat(data, { liveId, tenantId, state, produtos }) {
  state.comments_count += 1
  state.dirty = true

  // Emit evento individual (novo — §3.1)
  _emitter.emit(`event:${liveId}`, {
    type: 'chat',
    user: data.uniqueId,
    comment: data.comment,
    ts: Date.now(),
  })

  // Keyword detection só se Shop API NÃO está ativo pra esse tenant
  const shopApiActive = await _isShopApiActive(tenantId)
  if (shopApiActive) return

  // ... lógica existente de keyword matching
}

async function _isShopApiActive(tenantId) {
  // Cache de 60s pra não bater no DB a cada chat
  const cached = _shopApiActiveCache.get(tenantId)
  if (cached && Date.now() - cached.ts < 60_000) return cached.value

  const { rows } = await _db.query(
    `SELECT 1 FROM tiktok_shop_tokens WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
    [tenantId]
  )
  const value = rows.length > 0
  _shopApiActiveCache.set(tenantId, { value, ts: Date.now() })
  return value
}

const _shopApiActiveCache = new Map()
```

## 5. Rotas

### 5.1 `src/routes/tiktok.js` — extensões (não reescrita)

Manter as rotas existentes (`/v1/tiktok/connect`, `/v1/tiktok/callback`, `/v1/tiktok/status`, `/v1/lives/:liveId/stream`). **Adicionar**:

#### `GET /v1/tiktok/shop/auth`
Gera signed state + retorna URL de autorização do Partner Center.

```javascript
import { createTikTokShopClient, createSignedState } from '../services/tiktok-shop.js'

app.get('/v1/tiktok/shop/auth', {
  preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master'])],
}, async (req) => {
  const nonce = crypto.randomBytes(8).toString('hex')
  const state = createSignedState({ tenantId: req.user.tenant_id, nonce })
  const client = createTikTokShopClient({
    appKey: process.env.TIKTOK_SHOP_APP_KEY,
    appSecret: process.env.TIKTOK_SHOP_APP_SECRET,
    log: app.log,
  })
  return { url: client.getAuthUrl(state) }
})
```

#### `GET /v1/tiktok/shop/callback`
Valida signed state, troca code → tokens, salva em `tiktok_shop_tokens`, redireciona.

```javascript
app.get('/v1/tiktok/shop/callback', async (req, reply) => {
  const { code, state } = req.query
  if (!code || !state) return reply.code(400).send({ error: 'code e state obrigatórios' })

  const verified = verifySignedState(state)
  if (!verified) return reply.code(400).send({ error: 'State inválido ou expirado' })

  // Verificar que o tenant ainda existe
  const tenantCheck = await app.db.query(`SELECT id FROM tenants WHERE id = $1`, [verified.tenantId])
  if (tenantCheck.rowCount === 0) return reply.code(404).send({ error: 'Tenant não encontrado' })

  const client = createTikTokShopClient({
    appKey: process.env.TIKTOK_SHOP_APP_KEY,
    appSecret: process.env.TIKTOK_SHOP_APP_SECRET,
    log: app.log,
  })
  const tokenData = await client.exchangeCodeForToken(code)

  await app.db.query(`
    INSERT INTO tiktok_shop_tokens
      (tenant_id, tiktok_shop_id, tiktok_seller_name, access_token, refresh_token,
       access_token_expires_at, refresh_token_expires_at, scopes, region)
    VALUES ($1, $2, $3, $4, $5,
      NOW() + ($6 || ' seconds')::interval,
      NOW() + ($7 || ' seconds')::interval,
      $8, 'BR')
    ON CONFLICT (tenant_id, tiktok_shop_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
      scopes = EXCLUDED.scopes,
      is_active = true,
      last_error = NULL,
      updated_at = NOW()
  `, [
    verified.tenantId,
    tokenData.open_id ?? tokenData.seller_id ?? 'unknown',
    tokenData.seller_name ?? null,
    tokenData.access_token,
    tokenData.refresh_token,
    String(tokenData.access_token_expire_in ?? 86400),
    String(tokenData.refresh_token_expire_in ?? 604800),
    tokenData.granted_scopes ?? [],
  ])

  const frontendUrl = process.env.FRONTEND_URL ?? ''
  reply.redirect(`${frontendUrl}/#/configuracoes?tiktok_shop=connected`)
})
```

#### `POST /v1/tiktok/shop/sync-orders`
Dispara sync manual pra o tenant logado (útil pra debug).

```javascript
app.post('/v1/tiktok/shop/sync-orders', {
  preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master'])],
}, async (req, reply) => {
  // Reusa o job, filtrando pra um tenant só
  // ... (implementação usa _syncTenantOrders diretamente)
})
```

#### `GET /v1/lives/:liveId/events`
SSE por-evento — ver §3.2.

### 5.2 Rotas **não** criadas

| Rota do plano original | Por quê não |
|---|---|
| `POST /v1/tiktok/live/connect` | Reconciliation cron do connector manager já conecta/desconecta automaticamente quando a live vira `em_andamento`. Endpoint manual só polui a API. |
| `POST /v1/tiktok/live/disconnect` | Idem. |
| `GET /v1/tiktok/live/stats/:username` | Use o SSE existente. Se precisar de pull HTTP, é `GET /v1/lives/:liveId/current-stats` (que já pode ser feito via `SELECT ... FROM live_snapshots ORDER BY captured_at DESC LIMIT 1`). |
| `POST /v1/royalties/calculate/:liveId` | Royalty é calculado pelo `_aggregateLiveGmv` no sync, não por endpoint manual. Billing engine gera o boleto em lote. |

## 6. Riscos explícitos (não pode ir a produção sem endereçar)

### 6.1 Gate regional — TikTok Shop BR

**BLOQUEADOR da Fase 2.** Antes de escrever qualquer código de Shop API:

1. Verificar no [TikTok Shop Partner Center](https://partner.tiktokshop.com) se a região **BR** está aberta para Partner API
2. A conta da Unikids (cliente piloto) tem acesso à Partner API BR? Ou só ao Seller Center comum?
3. O endpoint global `open-api.tiktokglobalshop.com` aceita credenciais BR? Ou BR usa outro host?
4. Quais scopes OAuth estão disponíveis na região BR?

**Se a resposta for "não":**
- Fase 2 inteira fica bloqueada
- Alternativa: input manual de GMV pelo apresentador via app (feature já suportada pela flag do §4.3)
- Documentar na spec que a integração Shop está em "aguardando viabilidade regional"

### 6.2 Circuit breaker do Live Connector

**Já endereçado em §3.3.** Resumo: contar erros em janela deslizante, marcar `lives.tiktok_connector_status = 'degraded'` no ultrapassar threshold, alertar via SSE e permitir fallback manual.

### 6.3 Rate limit da Shop API

**Já endereçado em §4.1.** Resumo: processar tenants em série com throttle de 200ms, retry com backoff em rate limit response, cron de refresh separado do cron de sync.

### 6.4 Keyword detection flag

**Já endereçado em §4.3.** Resumo: `_handleChat` consulta `tiktok_shop_tokens` (cached 60s) e skipa a detecção por keyword se Shop API estiver ativo para o tenant, evitando double-counting.

### 6.5 Migração de tokens

**Já endereçado em §2.5 e §2.6.** Resumo: Migration 031 backfill marca tokens antigos como expirados (forçando reconectar). Migration 032 é deferred — só roda após validar que ninguém lê de `tenants.tiktok_*`.

### 6.6 CSRF signed state

**Já endereçado em §3.4 e §5.1.** Resumo: `createSignedState` usa HMAC com `JWT_SECRET`, `verifySignedState` valida assinatura + TTL de 10 min. Substitui o TODO existente em `routes/tiktok.js:50-51`.

## 7. Variáveis de ambiente

Adicionar ao `.env.example`:

```env
# TikTok Shop Partner API
TIKTOK_SHOP_APP_KEY=
TIKTOK_SHOP_APP_SECRET=
TIKTOK_SHOP_BASE_URL=https://open-api.tiktokglobalshop.com  # Confirmar pra BR no §6.1
TIKTOK_GMV_STATUSES=COMPLETED,DELIVERED                     # Status que contam no GMV
TIKTOK_SYNC_THROTTLE_MS=200                                  # Delay entre tenants no sync
TIKTOK_CB_THRESHOLD=5                                        # Erros antes do circuit breaker abrir
TIKTOK_CB_WINDOW_MS=300000                                   # Janela de 5 min pro breaker
TIKTOK_MAX_CONNECTORS=20                                     # Já existente; não mexer

# Frontend URL pra redirect OAuth
FRONTEND_URL=https://app.livelab.com
```

## 8. Fases de Execução

### Fase 1 — Live real-time (sem Shop API) — PODE COMEÇAR

**Depende só do connector manager existente, que já funciona.**

1. Migration 029 — adicionar `tiktok_room_id`, `final_*`, `tiktok_connector_status` em `lives`; `gifts_diamonds`, `shares_count` em `live_snapshots`
2. Estender `tiktok-connector-manager.js`:
   - Adicionar handlers `gift`, `share`, `streamEnd`
   - Adicionar circuit breaker no handler `error`
   - Emitir eventos individuais no `event:${liveId}` (chat, gift, share)
   - Preencher `final_*` + `tiktok_connector_status` no `stopConnector`
3. Adicionar `GET /v1/lives/:liveId/events` em `routes/tiktok.js`
4. Adicionar validação CSRF signed state em `/v1/tiktok/callback` (sub­ituir o TODO atual)
5. Testes:
   - Estender `test/tiktok-connector-manager.test.js` com mocks de gift/share/streamEnd
   - Teste novo pra circuit breaker (simula 5 erros → verifica `circuitOpen = true`)
   - Smoke test do SSE `event:${liveId}` consumindo eventos mockados do emitter

### Fase 2 — TikTok Shop API — BLOQUEADA ATÉ GATE REGIONAL (§6.1)

1. **PRIMEIRO:** validar acesso à Partner API BR na conta Unikids
2. Registrar app no TikTok Shop Partner Center (aguardar aprovação, 5-10 dias)
3. Migration 027 (`tiktok_shop_tokens`) + Migration 028 (`tiktok_shop_orders`)
4. Criar `src/services/tiktok-shop.js`
5. Rotas `/v1/tiktok/shop/auth`, `/callback`, `/sync-orders`
6. `src/jobs/tiktok-shop-sync.js` + `src/jobs/tiktok-shop-token-refresh.js`
7. Registrar crons no `server.js`
8. Migration 031 (backfill de tokens de `tenants`)
9. Adicionar flag de keyword detection no `_handleChat` (§4.3)
10. Testes de signing, refresh e sync com mocks da API

### Fase 3 — Integração com Billing Engine

1. Validar que `billing_engine.js` agrega `lives.comissao_calculada` corretamente quando preenchida pelo sync
2. Teste end-to-end: sync mock de orders → `lives.fat_gerado` atualizado → `billing_engine` gera boleto quinzenal no dia 1/16
3. Documentar em `STATUS.md` que `fat_gerado` agora tem fonte TikTok Shop (não mais mock)

### Fase 4 — Observabilidade e produção

1. Dashboard de saúde dos connectors (quais estão degraded, quais offline)
2. Alerta quando token Shop expira sem refresh possível
3. Métricas de sync (sucessos, falhas, latência) → logs estruturados
4. Migration 032 (drop das colunas antigas em `tenants`) — só depois de 30 dias sem incidente

### Fase 5 — Frontend (fora do escopo desta spec)

Alinhar com a spec de frontend separada:
- Tela Configurações: botão "Conectar TikTok Shop"
- Dashboard de cabine: badge `tiktok_connector_status`
- Input manual de GMV quando `status = 'degraded'`
- Financeiro: mostrar origem do fat_gerado (manual vs sync)

## 9. Testes obrigatórios antes de merger

### Backend (`vitest`)

- [ ] `tiktok-connector-manager.test.js`: handlers novos (gift, share, streamEnd) emitem eventos corretos
- [ ] `tiktok-connector-manager.test.js`: circuit breaker dispara em 5 erros / 5 min
- [ ] `tiktok-connector-manager.test.js`: `stopConnector` popula `final_*` em `lives`
- [ ] `tiktok-shop-service.test.js` (novo): signing HMAC produz hash determinístico
- [ ] `tiktok-shop-service.test.js` (novo): `verifySignedState` rejeita state expirado
- [ ] `tiktok-shop-service.test.js` (novo): `verifySignedState` rejeita tamper
- [ ] `tiktok-shop-sync.test.js` (novo): upsert de order atualiza `counts_in_gmv` pelo status
- [ ] `tiktok-shop-sync.test.js` (novo): `_aggregateLiveGmv` não mexe em lives com `faturado_em`
- [ ] `tiktok-shop-sync.test.js` (novo): throttle entre tenants funciona
- [ ] `routes.regressions.test.js`: rotas novas `shop/auth`, `shop/callback` retornam status corretos com/sem auth

### Manual / E2E

- [ ] OAuth flow real com Partner Center (depois da aprovação da Fase 2)
- [ ] Live de teste em conta real do TikTok — verificar que gift/share chegam no frontend
- [ ] Kill switch do circuit breaker: injetar erros repetidos → verificar badge no app

## 10. Checklist antes de abrir PR (qualquer fase)

- [ ] `npm test` passa (zero falhas)
- [ ] `flutter analyze` no frontend passa (se houver mudança no contrato da API)
- [ ] Novas env vars documentadas em `.env.example`
- [ ] Migrations idempotentes (rodam múltiplas vezes sem erro)
- [ ] Nenhuma coluna/tabela criada em código ad-hoc (sem migration correspondente)
- [ ] RLS policies usam `current_setting('app.tenant_id', true)::uuid` (com `, true`)
- [ ] Queries em rotas autenticadas usam `app.dbTenant(tenantId)` + `db.release()` em `finally`
- [ ] Error handling: try/catch em handlers de eventos (não quebrar o connector com um throw em handler)
- [ ] Logs estruturados (`app.log.info({tenantId, ...}, 'mensagem')`), não `console.log`

## 11. Decisões abertas (para revisitar durante implementação)

1. **Matching de order → live:** heurística inicial (§4.1 `_matchOrderToLive`) usa janela temporal. Se gerar muitos falsos positivos, evoluir para usar eventos de chat ("cupom LIVE2026") ou webhooks específicos da Shop API.
2. **Refresh token TTL:** documento original assumia 7 dias; valor real depende do que a Partner API retorna. O código lida dinamicamente, mas monitorar.
3. **Multi-shop por tenant:** schema suporta (UNIQUE em `(tenant_id, tiktok_shop_id)`), mas UX do OAuth callback assume uma loja. Se virar requisito, adicionar seletor no frontend.
4. **Retenção de `tiktok_shop_orders.raw_data`:** JSONB cresce fast. Adicionar política de retenção (ex: drop raw_data após 90 dias, manter campos estruturados).

---

**Aprovado em:** 2026-04-12 (após auditoria prévia e decisões do product owner)
**Próximo passo:** criar plano de implementação em `docs/superpowers/plans/2026-04-12-tiktok-fase1-live-realtime.md` (Fase 1 primeiro — não depende do gate regional)
