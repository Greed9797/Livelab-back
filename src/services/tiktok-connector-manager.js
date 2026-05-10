// src/services/tiktok-connector-manager.js
import EventEmitter from 'node:events'

// ── Singleton state ───────────────────────────────────────────────────────────
let _db = null
let _log = null
const _liveMap = new Map()       // Map<liveId, entry>
const _emitter = new EventEmitter()
_emitter.setMaxListeners(0) // Unlimited — SSE clients each add one listener per live, removed on disconnect

const MAX_CONNECTORS = Number(process.env.TIKTOK_MAX_CONNECTORS ?? 20)
const FLUSH_INTERVAL_MS = 10_000  // Real-time: 6 inserts/min por live
const CIRCUIT_BREAKER_THRESHOLD = Number(process.env.TIKTOK_CB_THRESHOLD ?? 5)
const CIRCUIT_BREAKER_WINDOW_MS = Number(process.env.TIKTOK_CB_WINDOW_MS ?? 5 * 60_000)

let WebcastPushConnectionImpl = null

async function getWebcastPushConnection() {
  if (WebcastPushConnectionImpl) return WebcastPushConnectionImpl

  // TikTok Live ainda aguarda aprovação; mantém o pacote fora do boot path e
  // permite remover a dependência vulnerável enquanto a integração está inativa.
  const mod = await import('tiktok-live-connector')
  WebcastPushConnectionImpl = mod.WebcastPushConnection ?? mod.default?.WebcastPushConnection
  if (!WebcastPushConnectionImpl) {
    throw new Error('tiktok-live-connector indisponível')
  }
  return WebcastPushConnectionImpl
}

// ── Public API ────────────────────────────────────────────────────────────────

export function init({ db, log }) {
  _db = db
  _log = log
}

export function getEmitter() {
  return _emitter
}

export function has(liveId) {
  return _liveMap.has(liveId)
}

/**
 * Reconciliation loop — called by cron every 60s.
 * Diff between in-memory Map and ao_vivo lives in DB.
 * Starts missing connectors, stops stale ones.
 */
export async function syncLives() {
  if (!_db) return

  // W3-A: fallback do @ — usa o do contrato; se ausente, cai pro do cliente.
  // Lives sem @ em nenhum dos dois são puladas (não erro — apenas não viram connector).
  const { rows: activeLives } = await _db.query(`
    SELECT l.id, l.tenant_id,
           COALESCE(ct.tiktok_username, cl.tiktok_username) AS tiktok_username
    FROM lives l
    JOIN cabines c ON c.live_atual_id = l.id
    LEFT JOIN contratos ct ON ct.id = c.contrato_id
    LEFT JOIN clientes cl ON cl.id = COALESCE(ct.cliente_id, l.cliente_id)
    WHERE l.status = 'em_andamento'
      AND COALESCE(ct.tiktok_username, cl.tiktok_username) IS NOT NULL
  `)

  const activeIds = new Set(activeLives.map(r => r.id))

  // Stop connectors for lives that are no longer active
  for (const [liveId] of _liveMap) {
    if (!activeIds.has(liveId)) {
      await stopConnector(liveId)
    }
  }

  // Start connectors for active lives without one
  for (const live of activeLives) {
    if (!_liveMap.has(live.id)) {
      await startConnector(live.id, live.tenant_id, live.tiktok_username)
    }
  }
}

/**
 * Stops connector and does final flush.
 */
export async function stopConnector(liveId) {
  const entry = _liveMap.get(liveId)
  if (!entry) return

  clearInterval(entry.flushTimer)
  await _flushToDb(liveId, entry)

  // Preencher cache denormalizado em `lives` com métricas finais.
  // Escrita acontece uma vez por live (não path crítico), acelera reads do dashboard
  // sem exigir agregação de live_snapshots.
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
    entry.connection.removeAllListeners()
    await entry.connection.disconnect()
  } catch (err) {
    _log?.warn({ err, liveId }, 'tiktokManager: erro ao desconectar connector')
  }

  _liveMap.delete(liveId)
  _log?.info({ liveId }, 'tiktokManager: connector parado')
}

// ── Test reset ────────────────────────────────────────────────────────────────
export function _resetForTests() {
  for (const [liveId, entry] of _liveMap) {
    clearInterval(entry.flushTimer)
    try { entry.connection.disconnect() } catch {}
  }
  _liveMap.clear()
  _db = null
  _log = null
  _emitter.removeAllListeners()
}

// ── Internals ─────────────────────────────────────────────────────────────────

async function startConnector(liveId, tenantId, username) {
  if (_liveMap.size >= MAX_CONNECTORS) {
    _log?.warn({ liveId, MAX_CONNECTORS }, 'tiktokManager: limite de connectors atingido')
    return
  }

  // Cache live products for keyword matching on order detection
  let produtos = []
  try {
    const { rows } = await _db.query(
      `SELECT produto_nome, valor_unit FROM live_products WHERE live_id = $1 AND tenant_id = $2`,
      [liveId, tenantId]
    )
    produtos = rows
  } catch (err) {
    _log?.warn({ err, liveId }, 'tiktokManager: falha ao carregar produtos da live')
  }

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

  const WebcastPushConnection = await getWebcastPushConnection()
  const connection = new WebcastPushConnection(username)

  // ── Event handlers ────────────────────────────────────────────────────────
  connection.on('roomUser', (data) => {
    state.viewer_count = data.viewerCount ?? state.viewer_count
    state.total_viewers = Math.max(state.total_viewers, state.viewer_count)
    state.dirty = true
  })

  connection.on('like', (data) => {
    state.likes_count += (data.likeCount ?? 1)
    state.dirty = true
  })

  connection.on('social', () => {
    state.likes_count += 1
    state.dirty = true
  })

  connection.on('chat', (data) => {
    _handleChat(data, { liveId, tenantId, state, produtos }).catch(err => {
      _log?.error({ err, liveId }, 'tiktokManager: erro não tratado no handler chat')
    })
  })

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

  connection.on('share', (data) => {
    state.shares_count += 1
    state.dirty = true
    _emitter.emit(`event:${liveId}`, {
      type: 'share',
      user: data.uniqueId,
      ts: Date.now(),
    })
  })

  connection.on('streamEnd', () => {
    _log?.info({ liveId, username }, 'tiktokManager: streamEnd recebido do TikTok')
    stopConnector(liveId).catch(err => {
      _log?.error({ err, liveId }, 'tiktokManager: erro ao parar connector após streamEnd')
    })
  })

  connection.on('disconnected', () => {
    _log?.warn({ liveId, username }, 'tiktokManager: connector desconectado — cron reconectará')
    const entry = _liveMap.get(liveId)
    if (entry) entry.reconnecting = true
  })

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
  // ─────────────────────────────────────────────────────────────────────────

  let flushTimer
  flushTimer = setInterval(async () => {
    const entry = _liveMap.get(liveId)
    if (entry && entry.flushTimer === flushTimer) {
      await _flushToDb(liveId, entry).catch(err => {
        _log?.error({ err, liveId }, 'tiktokManager: erro no flush periódico')
      })
    }
  }, FLUSH_INTERVAL_MS)

  _liveMap.set(liveId, {
    connection,
    tenantId,
    username,
    produtos,
    state,
    flushTimer,
    reconnecting: false,
  })

  // Connect non-blocking — errors handled via 'error' event
  connection.connect().catch(err => {
    _log?.warn({ err, liveId, username }, 'tiktokManager: falha ao conectar — cron tentará novamente')
    clearInterval(flushTimer)
    _liveMap.delete(liveId)
  })

  _log?.info({ liveId, username }, 'tiktokManager: connector iniciado')
}

async function _flushToDb(liveId, entry) {
  const { state, tenantId } = entry
  if (!state.dirty || state.flushing) return

  state.flushing = true
  try {
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

    state.dirty = false
    state.lastFlush = Date.now()
  } catch (err) {
    _log?.error({ err, liveId }, 'tiktokManager: falha no flush — estado preservado em memória')
    return
  } finally {
    state.flushing = false
  }

  // Emit outside try/catch so SSE listener exceptions don't get logged as flush failures
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
}

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

  const matched = produtos.find(p =>
    comment.includes(p.produto_nome.toLowerCase())
  )
  if (!matched) return

  state.total_orders += 1
  state.gmv += Number(matched.valor_unit)
  state.dirty = true

  try {
    await _db.query(
      `UPDATE live_products
       SET quantidade = quantidade + 1,
           valor_total = valor_total + $1
       WHERE live_id = $2 AND tenant_id = $3 AND produto_nome ILIKE $4`,
      [matched.valor_unit, liveId, tenantId, matched.produto_nome]
    )
  } catch (err) {
    _log?.error({ err, liveId }, 'tiktokManager: erro ao atualizar live_products')
  }
}
