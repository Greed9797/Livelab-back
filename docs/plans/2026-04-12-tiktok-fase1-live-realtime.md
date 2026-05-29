# TikTok Fase 1 — Live Real-time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit per Task (not per Step).

**Goal:** Estender o `tiktok-connector-manager.js` existente com handlers de `gift`/`share`/`streamEnd`, circuit breaker, canal SSE por-evento e CSRF signed state no OAuth callback — sem depender da TikTok Shop API (Fase 2).

**Architecture:** Reutiliza o singleton connector manager (`src/services/tiktok-connector-manager.js`) e seu `EventEmitter` existente. Adiciona um segundo canal de eventos `event:${liveId}` (chat/gift/share individuais) co-existindo com o canal `snapshot:${liveId}` existente (agregados 30s). Métricas finais são cacheadas em `lives.final_*` no `stopConnector` pra evitar agregação de snapshots no read. Circuit breaker usa janela deslizante de erros e expõe saúde via `lives.tiktok_connector_status`.

**Tech Stack:** Node.js 20 · Fastify 5 · PostgreSQL 15 (Supabase) · node-cron 4 · tiktok-live-connector 2.1.1-beta1 · vitest 4 · node-crypto (HMAC)

**Spec base:** `docs/specs/2026-04-12-tiktok-integration.md` (Fase 1, §8)

---

## File Structure

### Created
| Path | Responsibility |
|---|---|
| `migrations/029_lives_tiktok_fields.sql` | Colunas novas em `lives` e `live_snapshots` |
| `src/services/oauth-state.js` | Helper de CSRF signed state (HMAC + TTL) |
| `test/oauth-state.test.js` | Testes unitários do helper CSRF |
| `docs/plans/2026-04-12-tiktok-fase1-live-realtime.md` | Este arquivo |

### Modified
| Path | Mudança |
|---|---|
| `src/services/tiktok-connector-manager.js` | Novos handlers (`gift`, `share`, `streamEnd`), circuit breaker, novo canal `event:${liveId}`, extensão de `state`, `_flushToDb`, `stopConnector` |
| `src/routes/tiktok.js` | CSRF state em `/v1/tiktok/connect` + `/callback`; novo endpoint `GET /v1/lives/:liveId/events` |
| `test/tiktok-connector-manager.test.js` | Testes para handlers novos, circuit breaker, `stopConnector` cache |
| `test/routes.regressions.test.js` | Testes para CSRF e novo endpoint SSE events |
| `apply_migrations.js` | Registrar migration 029 na lista |
| `.env.example` | Novas env vars (`TIKTOK_CB_THRESHOLD`, `TIKTOK_CB_WINDOW_MS`, `FRONTEND_URL`) |

### Not touched
- `src/services/asaas.js` — intocada
- `src/jobs/billing_engine.js` — intocada (royalties continuam via `comissao_calculada`)
- `src/server.js` — intocada (reconciliation cron já existe)
- Qualquer outro arquivo

---

## Task 0: Commit da spec + criar arquivo do plano

**Files:**
- New: `docs/plans/2026-04-12-tiktok-fase1-live-realtime.md`
- Existing: `docs/specs/2026-04-12-tiktok-integration.md`

- [ ] **Step 1: Verificar git status**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && git status --short
```

Expected: mostrar `?? docs/` entre os untracked

- [ ] **Step 2: Stage docs/ e commitar**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add docs/specs/2026-04-12-tiktok-integration.md docs/plans/2026-04-12-tiktok-fase1-live-realtime.md && \
git commit -m "$(cat <<'EOF'
docs(tiktok): spec + plano Fase 1 de integração Live real-time

Spec corrigida contra schema real (lives não live_sessions, comissao_calculada
não royalty_amount, tiktok_username em contratos não em lives, Asaas via
imports diretos não decorator). Plano da Fase 1 não depende do gate regional
da Shop API — só estende o connector manager existente, adiciona canal SSE
por-evento, circuit breaker e CSRF signed state no OAuth callback.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit criado com sucesso

---

## Task 1: Migration 029 — schema changes

**Files:**
- Create: `migrations/029_lives_tiktok_fields.sql`
- Modify: `apply_migrations.js` (adicionar à lista)

- [ ] **Step 1: Criar arquivo de migration**

Create `migrations/029_lives_tiktok_fields.sql`:

```sql
-- migrations/029_lives_tiktok_fields.sql
-- Fase 1 da integração TikTok: campos mínimos em lives e live_snapshots
-- Spec: docs/specs/2026-04-12-tiktok-integration.md §2.3

-- ─── 1. Metadados e cache de métricas finais em lives ──────────────────────
-- Só campos que NÃO podem ser derivados de live_snapshots ou contratos.
-- tiktok_username fica em contratos (migration 021), não em lives.

ALTER TABLE lives ADD COLUMN IF NOT EXISTS tiktok_room_id           TEXT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_peak_viewers       INTEGER;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_likes        BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_comments     BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_shares       BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_gifts_diamonds     BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_orders_count       INTEGER;

-- Status de saúde do connector (usado pelo circuit breaker)
ALTER TABLE lives ADD COLUMN IF NOT EXISTS tiktok_connector_status  TEXT NOT NULL DEFAULT 'ok';

-- CHECK constraint é adicionado separadamente pra ser idempotente em re-runs.
-- Se a constraint já existe, o DO block não falha.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lives_tiktok_connector_status_check'
  ) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_tiktok_connector_status_check
      CHECK (tiktok_connector_status IN ('ok', 'degraded', 'offline'));
  END IF;
END$$;

-- ─── 2. Extensões em live_snapshots ────────────────────────────────────────
ALTER TABLE live_snapshots ADD COLUMN IF NOT EXISTS gifts_diamonds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE live_snapshots ADD COLUMN IF NOT EXISTS shares_count   BIGINT NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Registrar no apply_migrations.js**

Modify `apply_migrations.js` adicionando `'029_lives_tiktok_fields.sql'` ao final do array `pendingMigrations` (após `'026_add_analytics_dashboard_indexes.sql'`).

- [ ] **Step 3: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add migrations/029_lives_tiktok_fields.sql apply_migrations.js && \
git commit -m "$(cat <<'EOF'
feat(db): migration 029 — campos TikTok em lives e live_snapshots

Adiciona metadados (tiktok_room_id) e cache de métricas finais (final_*)
em lives, plus gifts_diamonds/shares_count em live_snapshots. Status de
saúde do connector (tiktok_connector_status) alimenta circuit breaker.

Spec: docs/specs/2026-04-12-tiktok-integration.md §2.3

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Estender state do connector com gifts_diamonds e shares_count

**Files:**
- Modify: `src/services/tiktok-connector-manager.js` (state inicial + `_flushToDb`)
- Modify: `test/tiktok-connector-manager.test.js` (verifica colunas no flush)

- [ ] **Step 1: Escrever teste falho — flush inclui novas colunas**

Add to `test/tiktok-connector-manager.test.js` após o teste `'getEmitter retorna o mesmo emitter sempre'`:

```javascript
  it('_flushToDb persiste gifts_diamonds e shares_count nos snapshots', async () => {
    const liveId = 'live-flush-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    // Limpa queries do start, marca dirty e força flush via stopConnector
    db.query.mockClear()
    db.query.mockResolvedValue({ rows: [] })

    // Pega a entry interna do _liveMap pra setar state (via stopConnector final flush)
    // Primeiro precisamos marcar o state como dirty — acessamos via um hack:
    // o teste de flush acontece via stopConnector, que chama _flushToDb se dirty.
    // Como não expomos state, disparamos um roomUser handler pra marcar dirty.
    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const roomUserHandler = connection.on.mock.calls.find(([evt]) => evt === 'roomUser')[1]
    roomUserHandler({ viewerCount: 42 })

    await stopConnector(liveId)

    const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO live_snapshots'))
    expect(insertCall).toBeDefined()
    expect(insertCall[0]).toContain('gifts_diamonds')
    expect(insertCall[0]).toContain('shares_count')
  })
```

- [ ] **Step 2: Rodar o teste pra verificar que falha**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js -t '_flushToDb persiste gifts_diamonds'
```

Expected: FAIL (SQL atual não inclui essas colunas)

- [ ] **Step 3: Estender state inicial em startConnector**

Modify `src/services/tiktok-connector-manager.js`. Localize o bloco:

```javascript
  const state = {
    viewer_count: 0,
    total_viewers: 0,
    total_orders: 0,
    gmv: 0,
    likes_count: 0,
    comments_count: 0,
    dirty: false,
    flushing: false,
    lastFlush: Date.now(),
  }
```

Substitua por:

```javascript
  const state = {
    viewer_count: 0,
    total_viewers: 0,
    total_orders: 0,
    gmv: 0,
    likes_count: 0,
    comments_count: 0,
    gifts_diamonds: 0,
    shares_count: 0,
    dirty: false,
    flushing: false,
    lastFlush: Date.now(),
    // Circuit breaker state (Task 7)
    errorCount: 0,
    errorWindowStart: Date.now(),
    circuitOpen: false,
  }
```

- [ ] **Step 4: Estender _flushToDb com novas colunas**

Em `src/services/tiktok-connector-manager.js`, localize:

```javascript
    await _db.query(
      `INSERT INTO live_snapshots
         (live_id, tenant_id, viewer_count, total_viewers, total_orders,
          gmv, likes_count, comments_count, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        liveId, tenantId,
        state.viewer_count, state.total_viewers, state.total_orders,
        state.gmv, state.likes_count, state.comments_count,
      ]
    )
```

Substitua por:

```javascript
    await _db.query(
      `INSERT INTO live_snapshots
         (live_id, tenant_id, viewer_count, total_viewers, total_orders,
          gmv, likes_count, comments_count, gifts_diamonds, shares_count, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        liveId, tenantId,
        state.viewer_count, state.total_viewers, state.total_orders,
        state.gmv, state.likes_count, state.comments_count,
        state.gifts_diamonds, state.shares_count,
      ]
    )
```

E no emit do emitter (logo abaixo):

```javascript
  _emitter.emit(`snapshot:${liveId}`, {
    viewer_count:   state.viewer_count,
    total_viewers:  state.total_viewers,
    total_orders:   state.total_orders,
    gmv:            state.gmv,
    likes_count:    state.likes_count,
    comments_count: state.comments_count,
    gifts_diamonds: state.gifts_diamonds,
    shares_count:   state.shares_count,
  })
```

- [ ] **Step 5: Rodar teste, verificar que passa**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js -t '_flushToDb persiste gifts_diamonds'
```

Expected: PASS

- [ ] **Step 6: Rodar suite completa pra garantir que nada quebrou**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: todos os testes passam

- [ ] **Step 7: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/services/tiktok-connector-manager.js test/tiktok-connector-manager.test.js && \
git commit -m "$(cat <<'EOF'
feat(tiktok): state do connector inclui gifts_diamonds e shares_count

Estende state inicial + _flushToDb pra persistir os novos campos em
live_snapshots. Circuit breaker state também inicializado (usado no Task 7).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Handler `gift` — monetização de diamantes

**Files:**
- Modify: `src/services/tiktok-connector-manager.js` (novo handler em startConnector)
- Modify: `test/tiktok-connector-manager.test.js`

- [ ] **Step 1: Escrever teste falho — gift acumula diamantes e emite event**

Add to `test/tiktok-connector-manager.test.js`:

```javascript
  it('handler gift acumula diamantes e emite event:liveId', async () => {
    const liveId = 'live-gift-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    // Subscribe no event channel novo
    const receivedEvents = []
    getEmitter().on(`event:${liveId}`, (evt) => receivedEvents.push(evt))

    // Captura o handler do gift
    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const giftHandler = connection.on.mock.calls.find(([evt]) => evt === 'gift')[1]

    // Streak em progresso — NÃO deve contar
    giftHandler({
      giftType: 1, repeatEnd: false, repeatCount: 3,
      diamondCount: 10, uniqueId: 'alice', giftName: 'Rose',
    })

    expect(receivedEvents.length).toBe(0) // streak não finalizado

    // Streak finalizado — conta multiplicado
    giftHandler({
      giftType: 1, repeatEnd: true, repeatCount: 3,
      diamondCount: 10, uniqueId: 'alice', giftName: 'Rose',
    })

    expect(receivedEvents.length).toBe(1)
    expect(receivedEvents[0]).toMatchObject({
      type: 'gift', user: 'alice', giftName: 'Rose', diamonds: 30, repeatCount: 3,
    })

    // Gift único (não-streak) — conta imediato
    giftHandler({
      giftType: 2, diamondCount: 50,
      uniqueId: 'bob', giftName: 'Galaxy',
    })

    expect(receivedEvents.length).toBe(2)
    expect(receivedEvents[1]).toMatchObject({
      type: 'gift', user: 'bob', giftName: 'Galaxy', diamonds: 50,
    })
  })
```

- [ ] **Step 2: Rodar teste, verificar FAIL**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js -t 'handler gift acumula'
```

Expected: FAIL (handler `gift` não registrado)

- [ ] **Step 3: Implementar handler gift**

In `src/services/tiktok-connector-manager.js`, após o handler `connection.on('chat', ...)` existente, adicionar:

```javascript
  connection.on('gift', (data) => {
    // giftType === 1 + repeatEnd === false  → streak em progresso (ignorar)
    // giftType === 1 + repeatEnd === true   → streak finalizado (conta multiplicado)
    // giftType !== 1                        → gift único
    if (data.giftType === 1 && !data.repeatEnd) return

    const multiplier = data.giftType === 1 ? (data.repeatCount ?? 1) : 1
    const diamonds = (data.diamondCount ?? 0) * multiplier

    state.gifts_diamonds += diamonds
    state.dirty = true

    _emitter.emit(`event:${liveId}`, {
      type: 'gift',
      user: data.uniqueId,
      giftName: data.giftName,
      diamonds,
      repeatCount: data.repeatCount ?? 1,
      ts: Date.now(),
    })
  })
```

- [ ] **Step 4: Rodar teste, verificar PASS**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js -t 'handler gift acumula'
```

Expected: PASS

- [ ] **Step 5: Rodar suite completa**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: todos verdes

- [ ] **Step 6: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/services/tiktok-connector-manager.js test/tiktok-connector-manager.test.js && \
git commit -m "$(cat <<'EOF'
feat(tiktok): handler gift acumula diamantes e emite event:liveId

Diferencia streak em progresso (ignora) de streak finalizado (conta
multiplicado pelo repeatCount) e gift único (conta direto). Emite evento
individual no novo canal event:liveId pra consumo por SSE.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Handler `share`

**Files:**
- Modify: `src/services/tiktok-connector-manager.js`
- Modify: `test/tiktok-connector-manager.test.js`

- [ ] **Step 1: Escrever teste falho**

Add to `test/tiktok-connector-manager.test.js`:

```javascript
  it('handler share incrementa shares_count e emite event:liveId', async () => {
    const liveId = 'live-share-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    const receivedEvents = []
    getEmitter().on(`event:${liveId}`, (evt) => receivedEvents.push(evt))

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const shareHandler = connection.on.mock.calls.find(([evt]) => evt === 'share')[1]

    shareHandler({ uniqueId: 'carol' })
    shareHandler({ uniqueId: 'dave' })

    expect(receivedEvents.length).toBe(2)
    expect(receivedEvents[0]).toMatchObject({ type: 'share', user: 'carol' })
    expect(receivedEvents[1]).toMatchObject({ type: 'share', user: 'dave' })
  })
```

- [ ] **Step 2: Rodar teste, verificar FAIL**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js -t 'handler share incrementa'
```

Expected: FAIL

- [ ] **Step 3: Implementar handler share**

In `src/services/tiktok-connector-manager.js`, após o handler `gift` adicionado no Task 3:

```javascript
  connection.on('share', (data) => {
    state.shares_count += 1
    state.dirty = true
    _emitter.emit(`event:${liveId}`, {
      type: 'share',
      user: data.uniqueId,
      ts: Date.now(),
    })
  })
```

- [ ] **Step 4: Rodar teste + suite**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js && npm test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/services/tiktok-connector-manager.js test/tiktok-connector-manager.test.js && \
git commit -m "$(cat <<'EOF'
feat(tiktok): handler share incrementa shares_count e emite event:liveId

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Handler `streamEnd` + emissão individual de chat events

**Files:**
- Modify: `src/services/tiktok-connector-manager.js` (handler streamEnd + emit em `_handleChat`)
- Modify: `test/tiktok-connector-manager.test.js`

- [ ] **Step 1: Escrever teste falho — streamEnd e chat emit**

Add to `test/tiktok-connector-manager.test.js`:

```javascript
  it('handler streamEnd para o connector', async () => {
    const liveId = 'live-end-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()
    expect(has(liveId)).toBe(true)

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const streamEndHandler = connection.on.mock.calls.find(([evt]) => evt === 'streamEnd')[1]

    streamEndHandler()

    // Aguarda microtasks do stopConnector async
    await new Promise(r => setImmediate(r))

    expect(has(liveId)).toBe(false)
  })

  it('handler chat emite event:liveId com comment', async () => {
    const liveId = 'live-chat-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    const receivedEvents = []
    getEmitter().on(`event:${liveId}`, (evt) => receivedEvents.push(evt))

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const chatHandler = connection.on.mock.calls.find(([evt]) => evt === 'chat')[1]

    chatHandler({ uniqueId: 'eve', comment: 'adorei a live' })

    // chatHandler é async (retorna promise via _handleChat.catch), aguarda microtask
    await new Promise(r => setImmediate(r))

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1)
    const chatEvt = receivedEvents.find(e => e.type === 'chat')
    expect(chatEvt).toBeDefined()
    expect(chatEvt).toMatchObject({ type: 'chat', user: 'eve', comment: 'adorei a live' })
  })
```

- [ ] **Step 2: Rodar, verificar FAIL**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js -t 'streamEnd|chat emite'
```

Expected: FAIL

- [ ] **Step 3: Implementar streamEnd e emit em _handleChat**

In `src/services/tiktok-connector-manager.js`, após o handler `share`:

```javascript
  connection.on('streamEnd', () => {
    _log?.info({ liveId, username }, 'tiktokManager: streamEnd recebido do TikTok')
    stopConnector(liveId).catch(err => {
      _log?.error({ err, liveId }, 'tiktokManager: erro ao parar connector após streamEnd')
    })
  })
```

E em `_handleChat`, adicionar a emissão logo após `state.dirty = true` na primeira linha:

```javascript
async function _handleChat(data, { liveId, tenantId, state, produtos }) {
  state.comments_count += 1
  state.dirty = true

  _emitter.emit(`event:${liveId}`, {
    type: 'chat',
    user: data.uniqueId,
    comment: data.comment ?? '',
    ts: Date.now(),
  })

  const comment = (data.comment ?? '').toLowerCase()
  if (!comment.includes('quero')) return

  // ... resto inalterado
```

- [ ] **Step 4: Rodar teste + suite**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: todos verdes

- [ ] **Step 5: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/services/tiktok-connector-manager.js test/tiktok-connector-manager.test.js && \
git commit -m "$(cat <<'EOF'
feat(tiktok): handler streamEnd + emissão individual de chat events

streamEnd do TikTok dispara stopConnector (antes dependia só do cron).
Chat handler emite evento individual no canal event:liveId além da
keyword detection existente.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Populate final_* cache em lives no stopConnector

**Files:**
- Modify: `src/services/tiktok-connector-manager.js` (stopConnector)
- Modify: `test/tiktok-connector-manager.test.js`

- [ ] **Step 1: Escrever teste falho**

Add to `test/tiktok-connector-manager.test.js`:

```javascript
  it('stopConnector popula final_* em lives', async () => {
    const liveId = 'live-final-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    // Mutate state via handlers pra ter valores pra gravar
    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const roomUserHandler = connection.on.mock.calls.find(([evt]) => evt === 'roomUser')[1]
    const likeHandler = connection.on.mock.calls.find(([evt]) => evt === 'like')[1]

    roomUserHandler({ viewerCount: 100 })
    likeHandler({ likeCount: 5 })

    // Limpa queries feitas no start
    db.query.mockClear()
    db.query.mockResolvedValue({ rows: [] })

    await stopConnector(liveId)

    const updateCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE lives') && sql.includes('final_peak_viewers')
    )
    expect(updateCall).toBeDefined()
    // Verify it sends final_* values
    expect(updateCall[0]).toContain('final_total_likes')
    expect(updateCall[0]).toContain('final_total_comments')
    expect(updateCall[0]).toContain('final_total_shares')
    expect(updateCall[0]).toContain('final_gifts_diamonds')
    expect(updateCall[0]).toContain('final_orders_count')
  })
```

- [ ] **Step 2: Rodar, verificar FAIL**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js -t 'stopConnector popula final'
```

Expected: FAIL

- [ ] **Step 3: Implementar update em stopConnector**

In `src/services/tiktok-connector-manager.js`, modificar `stopConnector`:

```javascript
export async function stopConnector(liveId) {
  const entry = _liveMap.get(liveId)
  if (!entry) return

  clearInterval(entry.flushTimer)
  await _flushToDb(liveId, entry)

  // Preencher cache denormalizado em `lives` com métricas finais
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

  try {
    await entry.connection.disconnect()
  } catch (err) {
    _log?.warn({ err, liveId }, 'tiktokManager: erro ao desconectar connector')
  }

  _liveMap.delete(liveId)
  _log?.info({ liveId }, 'tiktokManager: connector parado')
}
```

- [ ] **Step 4: Rodar teste + suite**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: todos verdes

- [ ] **Step 5: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/services/tiktok-connector-manager.js test/tiktok-connector-manager.test.js && \
git commit -m "$(cat <<'EOF'
feat(tiktok): stopConnector popula cache final_* em lives

Cache denormalizado de métricas finais evita agregação de live_snapshots
no read do dashboard. Escrita só acontece no stopConnector (uma vez por
live), não é path crítico.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Circuit breaker no handler error

**Files:**
- Modify: `src/services/tiktok-connector-manager.js` (handler error + constantes)
- Modify: `test/tiktok-connector-manager.test.js`

- [ ] **Step 1: Escrever teste falho**

Add to `test/tiktok-connector-manager.test.js`:

```javascript
  it('circuit breaker abre após 5 erros e emite health event', async () => {
    const liveId = 'live-cb-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    const healthEvents = []
    getEmitter().on(`health:${liveId}`, (evt) => healthEvents.push(evt))

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const errorHandler = connection.on.mock.calls.find(([evt]) => evt === 'error')[1]

    // Fire 4 errors - below threshold
    for (let i = 0; i < 4; i++) errorHandler(new Error(`err ${i}`))
    expect(healthEvents.length).toBe(0)

    // 5th error — circuit breaker opens
    errorHandler(new Error('err 5'))

    // Aguarda microtask pro UPDATE lives async
    await new Promise(r => setImmediate(r))

    expect(healthEvents.length).toBe(1)
    expect(healthEvents[0]).toMatchObject({
      type: 'connector_degraded',
      liveId,
      errorCount: 5,
    })

    // Verifica UPDATE lives foi chamado com 'degraded'
    const updateCall = db.query.mock.calls.find(([sql, params]) =>
      sql.includes('tiktok_connector_status') && params?.includes('degraded')
    )
    expect(updateCall).toBeDefined()
  })
```

- [ ] **Step 2: Rodar, verificar FAIL**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/tiktok-connector-manager.test.js -t 'circuit breaker'
```

Expected: FAIL

- [ ] **Step 3: Adicionar constantes e implementar circuit breaker**

In `src/services/tiktok-connector-manager.js`, após as constantes `MAX_CONNECTORS` e `FLUSH_INTERVAL_MS`, adicionar:

```javascript
const CIRCUIT_BREAKER_THRESHOLD = Number(process.env.TIKTOK_CB_THRESHOLD ?? 5)
const CIRCUIT_BREAKER_WINDOW_MS = Number(process.env.TIKTOK_CB_WINDOW_MS ?? 5 * 60_000)
```

E substituir o handler `connection.on('error', ...)` atual por:

```javascript
  connection.on('error', (err) => {
    _log?.warn({ err, liveId, username }, 'tiktokManager: erro no connector')

    // Circuit breaker: janela deslizante de erros
    const now = Date.now()
    if (now - state.errorWindowStart > CIRCUIT_BREAKER_WINDOW_MS) {
      state.errorWindowStart = now
      state.errorCount = 0
    }
    state.errorCount += 1

    if (state.errorCount >= CIRCUIT_BREAKER_THRESHOLD && !state.circuitOpen) {
      state.circuitOpen = true
      _log?.error(
        { liveId, username, errorCount: state.errorCount },
        'tiktokManager: CIRCUIT BREAKER OPEN — connector em estado degradado'
      )
      _emitter.emit(`health:${liveId}`, {
        type: 'connector_degraded',
        liveId,
        errorCount: state.errorCount,
        ts: now,
      })
      _db.query(
        `UPDATE lives SET tiktok_connector_status = 'degraded' WHERE id = $1`,
        [liveId]
      ).catch(updateErr => {
        _log?.error({ err: updateErr, liveId }, 'tiktokManager: falha ao marcar degraded')
      })
    }
  })
```

- [ ] **Step 4: Rodar teste + suite**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: todos verdes

- [ ] **Step 5: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/services/tiktok-connector-manager.js test/tiktok-connector-manager.test.js && \
git commit -m "$(cat <<'EOF'
feat(tiktok): circuit breaker no handler error do connector

Janela deslizante de 5 min conta erros. Ao atingir 5 (configurável via
TIKTOK_CB_THRESHOLD), marca lives.tiktok_connector_status='degraded' e
emite health:liveId pro frontend exibir badge offline + fallback manual.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: OAuth signed state helper

**Files:**
- Create: `src/services/oauth-state.js`
- Create: `test/oauth-state.test.js`

- [ ] **Step 1: Criar teste falho**

Create `test/oauth-state.test.js`:

```javascript
// test/oauth-state.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { createSignedState, verifySignedState } from '../src/services/oauth-state.js'

describe('oauth-state', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-please-ok'
  })

  it('round-trip de state válido retorna tenantId', () => {
    const state = createSignedState({ tenantId: '00000000-0000-0000-0000-000000000001', nonce: 'abc' })
    const verified = verifySignedState(state)
    expect(verified).not.toBeNull()
    expect(verified.tenantId).toBe('00000000-0000-0000-0000-000000000001')
    expect(verified.nonce).toBe('abc')
  })

  it('rejeita state com assinatura tampered', () => {
    const state = createSignedState({ tenantId: 'tenant-1', nonce: 'abc' })
    const tampered = state.slice(0, -4) + 'XXXX'
    expect(verifySignedState(tampered)).toBeNull()
  })

  it('rejeita state expirado', () => {
    const state = createSignedState({ tenantId: 'tenant-1', nonce: 'abc' })
    // TTL de 1ms forçando expiração
    expect(verifySignedState(state, 1)).toBeNull()
  })

  it('rejeita state com formato inválido', () => {
    expect(verifySignedState('foo')).toBeNull()
    expect(verifySignedState('foo:bar')).toBeNull()
    expect(verifySignedState('foo:bar:baz')).toBeNull()
  })

  it('rejeita state com tenantId alterado', () => {
    const state = createSignedState({ tenantId: 'tenant-1', nonce: 'abc' })
    const parts = state.split(':')
    parts[0] = 'tenant-2'
    const tampered = parts.join(':')
    expect(verifySignedState(tampered)).toBeNull()
  })
})
```

- [ ] **Step 2: Rodar, verificar FAIL**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/oauth-state.test.js
```

Expected: FAIL (módulo não existe)

- [ ] **Step 3: Implementar helper**

Create `src/services/oauth-state.js`:

```javascript
// src/services/oauth-state.js
// CSRF signed state pra OAuth flows (TikTok Live + TikTok Shop).
// Formato: `tenantId:nonce:timestamp:hmacSig16`
// Assinado com HMAC-SHA256 usando JWT_SECRET.

import crypto from 'node:crypto'

const DEFAULT_MAX_AGE_MS = 10 * 60_000 // 10 minutos

function _secret() {
  const s = process.env.JWT_SECRET
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET não configurado ou muito curto (mínimo 32 chars)')
  }
  return s
}

function _sign(payload) {
  return crypto.createHmac('sha256', _secret()).update(payload).digest('hex').slice(0, 16)
}

/**
 * Gera state assinado pra OAuth flow.
 * @param {{ tenantId: string, nonce: string }} params
 * @returns {string} state no formato `tenantId:nonce:timestamp:sig16`
 */
export function createSignedState({ tenantId, nonce }) {
  if (!tenantId || !nonce) {
    throw new Error('tenantId e nonce obrigatórios')
  }
  const ts = Date.now()
  const payload = `${tenantId}:${nonce}:${ts}`
  const sig = _sign(payload)
  return `${payload}:${sig}`
}

/**
 * Valida state assinado.
 * @param {string} state
 * @param {number} [maxAgeMs=600000] TTL em ms (default 10 min)
 * @returns {{tenantId: string, nonce: string, ts: number} | null}
 */
export function verifySignedState(state, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (typeof state !== 'string') return null
  const parts = state.split(':')
  if (parts.length !== 4) return null

  const [tenantId, nonce, tsStr, sig] = parts
  const payload = `${tenantId}:${nonce}:${tsStr}`
  const expected = _sign(payload)

  // Comparação timing-safe
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

  const ts = Number(tsStr)
  if (!Number.isFinite(ts)) return null
  if (Date.now() - ts > maxAgeMs) return null

  return { tenantId, nonce, ts }
}
```

- [ ] **Step 4: Rodar teste, verificar PASS**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/oauth-state.test.js
```

Expected: 5 tests passing

- [ ] **Step 5: Rodar suite completa**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: todos verdes

- [ ] **Step 6: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/services/oauth-state.js test/oauth-state.test.js && \
git commit -m "$(cat <<'EOF'
feat(auth): OAuth signed state helper (HMAC + TTL)

createSignedState/verifySignedState pra CSRF protection no OAuth callback.
Assina payload com JWT_SECRET (HMAC-SHA256), inclui timestamp com TTL de
10 min, comparação timing-safe. Usado pelo TikTok Live OAuth (Fase 1) e
pelo TikTok Shop OAuth (Fase 2).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wire CSRF no TikTok OAuth callback

**Files:**
- Modify: `src/routes/tiktok.js` (connect + callback)

- [ ] **Step 1: Modificar /v1/tiktok/connect pra gerar signed state**

In `src/routes/tiktok.js`, localize a rota `/v1/tiktok/connect`:

```javascript
  app.get('/v1/tiktok/connect', { preHandler: [app.authenticate, app.requirePapel(['franqueado'])] }, async (request, reply) => {
    // Usamos o tenantId no state para saber de qual tenant é esse callback
    const state = request.user.tenant_id;
    const scope = 'live.info.read,live.commerce.read'; // Escopos necessários
    const responseType = 'code';
```

Substitua o `const state = request.user.tenant_id;` por:

```javascript
    // CSRF signed state (HMAC + TTL 10 min) — previne replay e tampering
    const nonce = crypto.randomBytes(8).toString('hex');
    const state = createSignedState({ tenantId: request.user.tenant_id, nonce });
    const scope = 'live.info.read,live.commerce.read';
    const responseType = 'code';
```

E no topo do arquivo, adicionar imports (antes ou depois de `import { getEmitter } ...`):

```javascript
import crypto from 'node:crypto'
import { createSignedState, verifySignedState } from '../services/oauth-state.js'
```

- [ ] **Step 2: Modificar /v1/tiktok/callback pra verificar signed state**

Localize:

```javascript
    const tenantId = state;

    // Validar que state é um UUID válido antes de usar como tenant_id.
    // TODO: quando a integração real TikTok ativar, substituir por HMAC-signed token
    // que contenha tenant_id + timestamp + nonce para prevenir CSRF.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRe.test(tenantId)) {
      return reply.code(400).send({ error: 'State inválido' })
    }
```

Substitua por:

```javascript
    // Verifica signed state (CSRF). Rejeita se tampered ou expirado (>10 min).
    const verified = verifySignedState(state)
    if (!verified) {
      app.log.warn({ state: state?.slice(0, 8) }, '[TikTok OAuth] state inválido ou expirado')
      return reply.code(400).send({ error: 'State inválido ou expirado' })
    }
    const tenantId = verified.tenantId
```

- [ ] **Step 3: Escrever teste do CSRF no callback**

Add to `test/routes.regressions.test.js` (encontrar o describe block do tiktok ou criar um novo). Localize o final do arquivo antes do último `})` de describe mais externo e adicionar:

```javascript
  describe('TikTok OAuth CSRF', () => {
    it('GET /v1/tiktok/callback rejeita state sem assinatura', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tiktok/callback?code=fake&state=00000000-0000-0000-0000-000000000001',
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toMatch(/State inválido/)
    })

    it('GET /v1/tiktok/callback rejeita state tampered', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tiktok/callback?code=fake&state=tenant-1:nonce:9999999999999:BADSIG1234567890',
      })
      expect(res.statusCode).toBe(400)
    })
  })
```

**Nota:** o teste existente de regressão mocka o db pro dbTenant. Se o `describe` mais externo já tem setup de `app`, reutilizar. Se não, criar o setup necessário inspirando-se no estilo dos testes próximos.

- [ ] **Step 4: Rodar testes**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: todos verdes. Se o teste do callback não rodar por falta de setup, ajustar inspirando-se no mock de `validarWebhookToken` em testes existentes.

- [ ] **Step 5: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/routes/tiktok.js test/routes.regressions.test.js && \
git commit -m "$(cat <<'EOF'
security(tiktok): CSRF signed state no OAuth callback

Substitui o TODO existente em /v1/tiktok/callback por verificação de
signed state (HMAC + TTL 10 min). /v1/tiktok/connect gera state assinado
com nonce random. Impede CSRF + replay attacks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: GET /v1/lives/:liveId/events (SSE)

**Files:**
- Modify: `src/routes/tiktok.js` (novo endpoint)
- Modify: `test/routes.regressions.test.js`

- [ ] **Step 1: Escrever teste falho — 404 pra live inexistente**

Add to `test/routes.regressions.test.js` (dentro do describe de tiktok ou separado):

```javascript
  describe('GET /v1/lives/:liveId/events (SSE)', () => {
    it('retorna 404 se live não existe ou não está em_andamento', async () => {
      const fakeLiveId = '00000000-0000-0000-0000-000000000999'
      const res = await app.inject({
        method: 'GET',
        url: `/v1/lives/${fakeLiveId}/events`,
        headers: { authorization: `Bearer ${tokenFranqueado}` },
      })
      expect(res.statusCode).toBe(404)
    })
  })
```

**Nota:** usar a infra de auth mock que já existe no `routes.regressions.test.js`. Se o `tokenFranqueado` não existe no contexto, seguir o padrão dos outros testes do arquivo (provavelmente mockam `app.authenticate`).

- [ ] **Step 2: Rodar, verificar FAIL**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
npx vitest run test/routes.regressions.test.js -t 'events'
```

Expected: FAIL (rota não existe → 404 genérico do Fastify)

- [ ] **Step 3: Implementar endpoint**

In `src/routes/tiktok.js`, após o endpoint `/v1/lives/:liveId/stream` existente, adicionar:

```javascript
  // ── GET /v1/lives/:liveId/events — SSE por-evento (chat/gift/share) ──
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

- [ ] **Step 4: Rodar teste**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: todos verdes

- [ ] **Step 5: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add src/routes/tiktok.js test/routes.regressions.test.js && \
git commit -m "$(cat <<'EOF'
feat(tiktok): GET /v1/lives/:liveId/events — SSE por-evento

Novo canal SSE expõe chat/gift/share individuais emitidos pelo connector
manager (event:liveId). Coexiste com /stream existente (snapshots
agregados a cada 30s). Validação de ownership via JOIN em lives.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Atualizar .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Adicionar vars ao .env.example**

Modify `.env.example` adicionando ao final:

```env

# TikTok Live Connector — circuit breaker
TIKTOK_CB_THRESHOLD=5
TIKTOK_CB_WINDOW_MS=300000
TIKTOK_MAX_CONNECTORS=20

# Frontend URL pra redirect OAuth (TikTok OAuth callback)
FRONTEND_URL=https://app.livelab.com
```

- [ ] **Step 2: Commit**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
git add .env.example && \
git commit -m "$(cat <<'EOF'
chore(env): documentar vars do circuit breaker TikTok

TIKTOK_CB_THRESHOLD, TIKTOK_CB_WINDOW_MS, TIKTOK_MAX_CONNECTORS,
FRONTEND_URL — todas têm defaults sensatos no código, .env.example
só documenta pra onboarding.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Verificação final

- [ ] **Step 1: Rodar suite completa**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && npm test
```

Expected: **todos** verdes (original 18 + novos ~12 = ~30 testes)

- [ ] **Step 2: Scan por artifacts deixados no código**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && \
grep -rn 'console\.log\|TODO: tiktok\|XXX' src/services/tiktok-connector-manager.js src/services/oauth-state.js src/routes/tiktok.js
```

Expected: nada relevante. `console.log` só se já existia (não introduzido por esta fase).

- [ ] **Step 3: Ver log de commits da fase**

```bash
cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && git log --oneline -15
```

Expected: ver os ~12 commits da fase em sequência, master à frente de 782a470.

- [ ] **Step 4: Sumarizar ao usuário**

Não há commit — apenas reportar ao user:
- Número de commits criados
- Número de testes (antes vs depois)
- Arquivos tocados
- Próximos passos (Fase 2 aguarda gate regional, Fase 3 é integração com billing_engine)

---

## Self-Review (inline)

**1. Spec coverage:** Fase 1 da spec (§8) tem 5 sub-itens:
- ✅ Migration 029 → Task 1
- ✅ Estender connector (gift/share/streamEnd/circuit breaker/final_*/emit event) → Tasks 2-7
- ✅ GET /v1/lives/:liveId/events → Task 10
- ✅ CSRF signed state → Tasks 8-9
- ✅ Testes → TDD ao longo de Tasks 2-10

**2. Placeholder scan:** Nenhum "TBD", "add appropriate", "similar to N" ou "implement later" no plano. Todos os code blocks são completos.

**3. Type consistency:**
- `createSignedState({tenantId, nonce})` / `verifySignedState(state, maxAgeMs)` consistentes entre Tasks 8 e 9
- `event:${liveId}` canal consistente entre Tasks 3, 4, 5 e 10
- `health:${liveId}` canal criado em Task 7, não consumido no plano (frontend consumirá)
- `final_peak_viewers, final_total_likes, final_total_comments, final_total_shares, final_gifts_diamonds, final_orders_count` consistentes entre Task 1 (DDL), Task 6 (UPDATE) e Task 12 (review)
- `tiktok_connector_status` consistente entre Task 1 (DDL + CHECK), Task 7 (UPDATE 'degraded') e review

**Nenhuma inconsistência encontrada.**

---

## Observações pra quem executa

1. **Commits só depois do teste passar** — cada Task é TDD. Se o teste não fica verde, não commita, não passa pra próxima.
2. **Não criar branches** — user pediu commits diretos. Trabalhar em `master` do backend (`liveshop_saas_api-backend-`).
3. **Diretório de trabalho é o backend, não o frontend** — CWD inicial pode ser o frontend, mas todos os comandos usam `cd /Users/vitormiguelgoedertdaluz/liveshop_saas_api-backend- && ...`.
4. **Migration 029 não é aplicada no DB real** — só criada e registrada. Aplicação manual via `node apply_migrations.js` fica a cargo do usuário em ambiente de dev/prod.
5. **Os testes de SSE (Task 10) não testam o stream em si** — só a rejeição 404. Testar streaming completo exige teardown manual do `request.raw.once('close', ...)` e fica pra e2e.
6. **Se algum teste quebrar inesperadamente**, parar, reportar o output, não tentar "consertar" ignorando a causa.
