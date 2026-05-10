/**
 * Rotas de Integração OAuth com o TikTok
 * Responsável por conectar a conta do TikTok do Franqueado e gerar os Tokens
 */

import crypto from 'node:crypto'
import * as connectorManager from '../services/tiktok-connector-manager.js'
import { getEmitter } from '../services/tiktok-connector-manager.js'
import { createSignedState, verifySignedState } from '../services/oauth-state.js'
import { encryptToken } from '../services/token-crypto.js'

export async function tiktokRoutes(app) {
  const tiktokUrlVerification = {
    fileName: 'tiktokqs5mPOzi5Iq2tckHy7mVhYMDBFtf0oDd.txt',
    body: 'tiktok-developers-site-verification=qs5mPOzi5Iq2tckHy7mVhYMDBFtf0oDd',
  }
  const TIKTOK_CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY;
  const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
  const TIKTOK_REDIRECT_URI  = process.env.TIKTOK_REDIRECT_URI;
  // Em produção a signature é sempre obrigatória; toggle só vale fora de prod
  // (staging/dev) para facilitar debug local.
  const requireWebhookSignature = process.env.NODE_ENV === 'production'
    ? true
    : (process.env.TIKTOK_WEBHOOK_REQUIRE_SIGNATURE !== 'false')
  const webhookSignatureToleranceSeconds = Number(
    process.env.TIKTOK_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS ?? 300
  )
  const oauthEnabled = process.env.TIKTOK_OAUTH_ENABLED === 'true'
  const hasOauthConfig = Boolean(
    oauthEnabled && TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET && TIKTOK_REDIRECT_URI
  )

  if (!oauthEnabled) {
    app.log.warn('[TikTok OAuth] Desabilitado (TIKTOK_OAUTH_ENABLED!=true). Aguardando aprovação dos escopos pela TikTok.')
  } else if (!hasOauthConfig) {
    app.log.warn(
      '[TikTok OAuth] Credenciais ausentes; rotas de OAuth ficarão indisponíveis até configurar TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET e TIKTOK_REDIRECT_URI'
    )
  }

  app.get(`/${tiktokUrlVerification.fileName}`, async (request, reply) => {
    return reply
      .type('text/plain; charset=utf-8')
      .send(tiktokUrlVerification.body)
  })

  /**
   * GET /v1/tiktok/connect
   * Gera a URL de OAuth do TikTok e retorna para o Frontend (Painel do Franqueado)
   */
  app.get('/v1/tiktok/connect', { preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master', 'gerente'])] }, async (request, reply) => {
    if (!oauthEnabled) {
      return reply.code(503).send({
        error: 'Integração TikTok OAuth temporariamente indisponível (aguardando aprovação dos escopos pela TikTok).',
      })
    }
    if (!hasOauthConfig) {
      return reply.code(503).send({
        error: 'Integração TikTok OAuth não configurada no servidor',
      })
    }

    // CSRF signed state (HMAC + TTL 10 min) — previne replay e tampering.
    // Substitui o padrão antigo que usava tenant_id raw (vulnerável a CSRF).
    const nonce = crypto.randomBytes(8).toString('hex');
    const state = createSignedState({ tenantId: request.user.tenant_id, nonce });
    // Escopos aprovados no app sandbox TikTok (Live Studio).
    // live.info.read / live.commerce.read exigem aprovação Live Shop API (programa restrito) — adicionar quando aprovado.
    const scope = 'user.info.basic';
    const responseType = 'code';

    // URL oficial de autorização do TikTok V2
    const oauthUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${TIKTOK_CLIENT_KEY}&scope=${scope}&response_type=${responseType}&redirect_uri=${encodeURIComponent(TIKTOK_REDIRECT_URI)}&state=${state}`;

    return reply.send({ url: oauthUrl });
  });

  /**
   * GET /v1/tiktok/callback
   * Recebe o 'code' do TikTok após o login do usuário e troca por Access Token
   */
  app.get('/v1/tiktok/callback', async (request, reply) => {
    // S-12: CSP global bloqueia scripts; HTML do callback usa style inline.
    // Override permite style mas mantém scriptSrc 'none'.
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    )
    if (!oauthEnabled) {
      return reply.code(503).send({
        error: 'Integração TikTok OAuth temporariamente indisponível (aguardando aprovação dos escopos pela TikTok).',
      })
    }
    if (!hasOauthConfig) {
      return reply.code(503).send({
        error: 'Integração TikTok OAuth não configurada no servidor',
      })
    }

    const { code, state, error, error_description } = request.query;

    if (error) {
      app.log.error(`[TikTok OAuth] Erro retornado pelo TikTok: ${error_description}`);
      return reply.code(400).send({ error: 'Autorização negada ou falhou no TikTok', detalhes: error_description });
    }

    if (!code || !state) {
      return reply.code(400).send({ error: 'Parâmetros code e state são obrigatórios' });
    }

    // Verifica signed state (HMAC + TTL 10 min). Rejeita se tampered ou expirado.
    const verified = verifySignedState(state)
    if (!verified) {
      app.log.warn({ state: typeof state === 'string' ? state.slice(0, 8) : null },
        '[TikTok OAuth] state inválido ou expirado')
      return reply.code(400).send({ error: 'State inválido ou expirado' })
    }
    const tenantId = verified.tenantId

    try {
      // Verificar que o tenant existe antes de atualizar credenciais
      const tenantCheck = await app.db.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId])
      if (tenantCheck.rowCount === 0) {
        return reply.type('text/html').send(_errorPage('Conta não encontrada. Tente conectar novamente.'))
      }

      // Troca code → tokens via TikTok Open API v2
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: TIKTOK_CLIENT_KEY,
          client_secret: TIKTOK_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: TIKTOK_REDIRECT_URI,
        }).toString(),
      })
      const data = await tokenRes.json()

      if (data.error) {
        app.log.warn({ data }, '[TikTok OAuth] Erro na troca de código')
        return reply.type('text/html').send(_errorPage(`TikTok: ${data.error_description ?? data.error}`))
      }

      const expiresAt = new Date(Date.now() + data.expires_in * 1000)

      await app.db.query(`
        UPDATE tenants SET
          tiktok_access_token     = $1,
          tiktok_refresh_token    = $2,
          tiktok_token_expires_at = $3,
          tiktok_user_id          = $4
        WHERE id = $5
      `, [encryptToken(data.access_token), encryptToken(data.refresh_token), expiresAt, data.open_id, tenantId])

      const openIdMasked = String(data.open_id ?? '').slice(0, 4) + '***'
      app.log.info(`[TikTok OAuth] Token salvo para tenant ${tenantId} (open_id: ${openIdMasked})`)

      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:4200'
      return reply.type('text/html').send(_successPage(frontendUrl))

    } catch (err) {
      app.log.error({ err }, '[TikTok OAuth] Falha ao processar callback')
      return reply.type('text/html').send(_errorPage('Falha de comunicação com o TikTok. Tente novamente.'))
    }
  });

  /**
   * GET /v1/tiktok/status
   * Verifica se o tenant atual já possui o TikTok conectado e token válido
   */
  app.get('/v1/tiktok/status', { preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master', 'gerente'])] }, async (request, reply) => {
    const { tenant_id } = request.user
    const { rows } = await app.db.query(
      `SELECT tiktok_access_token, tiktok_user_id, tiktok_token_expires_at FROM tenants WHERE id = $1`,
      [tenant_id]
    )
    const t = rows[0]
    if (!t) return reply.code(404).send({ error: 'Tenant não encontrado' })

    const hasToken = !!t.tiktok_access_token
    const notExpired = t.tiktok_token_expires_at ? new Date(t.tiktok_token_expires_at) > new Date() : false
    const connected = hasToken && notExpired

    return reply.send({
      connected,
      tiktok_user_id: t.tiktok_user_id ?? null,
      token_expires_at: t.tiktok_token_expires_at ?? null,
    })
  })

  /**
   * OPTIONS /v1/tiktok/webhook — preflight para TikTok (origem externa)
   */
  app.options('/v1/tiktok/webhook', async (request, reply) => {
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Content-Type, tiktok-signature')
    return reply.code(204).send()
  })

  /**
   * POST /v1/tiktok/webhook
   * Recebe eventos assíncronos do TikTok Developer Portal.
   */
  app.post('/v1/tiktok/webhook', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
    const payload = isObject(request.body) ? request.body : {}
    const eventType = typeof payload.event === 'string' ? payload.event : 'UNKNOWN'
    const userOpenId = typeof payload.user_openid === 'string' ? payload.user_openid : null

    const signatureResult = verifyTikTokWebhookSignature({
      header: request.headers['tiktok-signature'],
      payload,
      rawBody: request.rawBody,
      clientSecret: TIKTOK_CLIENT_SECRET,
      toleranceSeconds: webhookSignatureToleranceSeconds,
    })

    if (!signatureResult.ok) {
      app.log.warn(
        { reason: signatureResult.reason, eventType },
        '[TikTok Webhook] Assinatura ausente ou inválida'
      )

      if (requireWebhookSignature) {
        return reply.code(401).send({ error: 'Assinatura TikTok inválida' })
      }
    }

    if (TIKTOK_CLIENT_KEY && payload.client_key && payload.client_key !== TIKTOK_CLIENT_KEY) {
      app.log.warn(
        { eventType, receivedClientKey: payload.client_key },
        '[TikTok Webhook] client_key diferente da configuração local'
      )
    }

    let tenantId = null

    try {
      if (userOpenId) {
        const { rows } = await app.db.query(
          `SELECT id FROM tenants WHERE tiktok_user_id = $1 LIMIT 1`,
          [userOpenId]
        )
        tenantId = rows[0]?.id ?? null
      }

      await app.db.query(
        `INSERT INTO webhook_eventos (tenant_id, source, event_type, payload_raw)
         VALUES ($1, 'tiktok', $2, $3::jsonb)`,
        [tenantId, eventType, JSON.stringify(payload)]
      )

      if (eventType === 'authorization.removed' && tenantId) {
        await app.db.query(
          `UPDATE tenants
           SET tiktok_access_token = NULL,
               tiktok_refresh_token = NULL,
               tiktok_token_expires_at = NULL
           WHERE id = $1`,
          [tenantId]
        )
      }
    } catch (err) {
      app.log.error({ err, eventType, userOpenId }, '[TikTok Webhook] Falha ao processar evento')
    }

    return reply.code(200).send({ received: true })
  })

  // ── POST /v1/tiktok/test-connector — inicia conector para qualquer @username (dev only) ──
  app.post('/v1/tiktok/test-connector', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master', 'gerente'])],
  }, async (request, reply) => {
    if (process.env.NODE_ENV === 'production') {
      return reply.code(403).send({ error: 'Endpoint disponível apenas em desenvolvimento' })
    }
    const { username, fake_live_id } = request.body ?? {}
    if (!username || typeof username !== 'string') {
      return reply.code(400).send({ error: 'username é obrigatório' })
    }
    const clean = username.replace(/^@/, '').trim()
    const liveId = fake_live_id ?? `test-${clean}-${Date.now()}`

    if (connectorManager.has(liveId)) {
      return reply.send({ ok: true, message: 'Connector já ativo', live_id: liveId })
    }
    await connectorManager.startConnector(liveId, request.user.tenant_id, clean, app.db)
    return reply.send({ ok: true, live_id: liveId, username: clean, sse: `/v1/lives/${liveId}/stream` })
  })

  // ── DELETE /v1/tiktok/test-connector/:liveId — para conector de teste ─────
  app.delete('/v1/tiktok/test-connector/:liveId', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master', 'gerente'])],
  }, async (request, reply) => {
    if (process.env.NODE_ENV === 'production') {
      return reply.code(403).send({ error: 'Endpoint disponível apenas em desenvolvimento' })
    }
    if (connectorManager.has(request.params.liveId)) {
      await connectorManager.stopConnector(request.params.liveId)
    }
    return reply.send({ ok: true })
  })

  // ── GET /v1/lives/:liveId/tiktok-status — snapshot do connector ───────────
  // Combina state da DB (lives.tiktok_connector_status, último snapshot)
  // com presença em memória (connectorManager.has) pra resolver o status
  // efetivo (connected/connecting/disconnected/error). W3-A.
  app.get('/v1/lives/:liveId/tiktok-status', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master', 'gerente', 'apresentador', 'apresentadora', 'produtor_live'])],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { liveId } = request.params

    const liveQ = await app.db.query(
      `SELECT l.id, l.status, l.tiktok_connector_status,
              COALESCE(ct.tiktok_username, cl.tiktok_username) AS tiktok_username
       FROM lives l
       LEFT JOIN cabines cb ON cb.live_atual_id = l.id
       LEFT JOIN contratos ct ON ct.id = cb.contrato_id
       LEFT JOIN clientes cl ON cl.id = COALESCE(ct.cliente_id, l.cliente_id)
       WHERE l.id = $1 AND l.tenant_id = $2::uuid`,
      [liveId, tenant_id]
    )
    if (liveQ.rows.length === 0) {
      return reply.code(404).send({ error: 'Live não encontrada' })
    }
    const live = liveQ.rows[0]

    const snapQ = await app.db.query(
      `SELECT viewer_count, captured_at
       FROM live_snapshots
       WHERE live_id = $1 AND tenant_id = $2::uuid
       ORDER BY captured_at DESC
       LIMIT 1`,
      [liveId, tenant_id]
    )
    const snap = snapQ.rows[0] ?? null

    const inMemory = connectorManager.has(liveId)
    let status
    let error = null
    if (live.status !== 'em_andamento') {
      status = 'disconnected'
    } else if (!live.tiktok_username) {
      status = 'error'
      error = 'TikTok @ ausente em contrato e cliente'
    } else if (live.tiktok_connector_status === 'degraded' || live.tiktok_connector_status === 'offline') {
      status = 'error'
      error = `connector ${live.tiktok_connector_status}`
    } else if (inMemory) {
      status = 'connected'
    } else {
      // Live ao vivo + @ ok mas sem connector: cron vai reconciliar em até 60s.
      status = 'connecting'
    }

    return reply.send({
      status,
      tiktok_username: live.tiktok_username ?? null,
      viewer_count: snap ? Number(snap.viewer_count) : 0,
      last_sync_at: snap?.captured_at ?? null,
      error,
    })
  })

  // ── GET /v1/lives/:liveId/events — SSE por-evento (chat/gift/share) ───────
  // Canal separado do /stream (snapshots agregados 30s). Emite eventos
  // individuais no momento em que acontecem na live — consumidor renderiza
  // chat ao vivo, gifts chegando, shares etc.
  app.get('/v1/lives/:liveId/events', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master', 'gerente'])]
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { liveId } = request.params

    // Validar ownership e status — mesma query do /stream existente
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
      if (reply.raw.destroyed) return
      try {
        reply.raw.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`)
      } catch {
        emitter.off(eventName, handler)
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

  // ── GET /v1/lives/:liveId/stream — SSE real-time ──────────────────────────
  app.get('/v1/lives/:liveId/stream', { preHandler: app.requirePapel(['franqueado', 'franqueador_master', 'gerente']) }, async (request, reply) => {
    const { tenant_id } = request.user
    const { liveId } = request.params

    // Validate live belongs to tenant and is active
    const { rows } = await app.db.query(
      `SELECT id FROM lives WHERE id = $1 AND tenant_id = $2 AND status = 'em_andamento'`,
      [liveId, tenant_id]
    )
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Live não encontrada ou não está ao vivo' })
    }

    // Take full control of the HTTP response
    reply.hijack()

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.flushHeaders()

    // Send the most recent snapshot immediately (initial state)
    try {
      const { rows: snap } = await app.db.query(
        `SELECT viewer_count, total_viewers, total_orders, gmv, likes_count, comments_count
         FROM live_snapshots
         WHERE live_id = $1
         ORDER BY captured_at DESC LIMIT 1`,
        [liveId]
      )
      if (snap[0]) {
        reply.raw.write(`data: ${JSON.stringify(snap[0])}\n\n`)
      }
    } catch (err) {
      app.log.warn({ err, liveId }, 'SSE: falha ao buscar snapshot inicial')
    }

    // Register listener on manager EventEmitter
    const emitter = getEmitter()
    const eventName = `snapshot:${liveId}`
    const handler = (snapshot) => {
      if (reply.raw.destroyed) return
      try {
        reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`)
      } catch {
        emitter.off(eventName, handler)
      }
    }
    emitter.on(eventName, handler)

    // Heartbeat every 15s to keep connection alive (prevents proxy timeouts)
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keep-alive\n\n')
    }, 15_000)

    // Wait for client disconnect
    await new Promise((resolve) => {
      request.raw.once('close', resolve)
      request.raw.once('error', resolve)
    })

    // Cleanup
    emitter.off(eventName, handler)
    clearInterval(heartbeat)
    try { reply.raw.end() } catch {}
  })
}

// ── HTML helpers para o OAuth callback ───────────────────────────────────────

function _successPage(frontendUrl) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>TikTok Conectado</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9f9f9}</style>
</head>
<body>
  <div style="text-align:center">
    <h2 style="color:#010101">✓ TikTok conectado com sucesso!</h2>
    <p style="color:#666">Esta aba será fechada automaticamente...</p>
  </div>
  <script>
    setTimeout(() => {
      window.close();
      if (window.opener) { window.opener.postMessage('tiktok_connected', '${frontendUrl}'); }
    }, 1500);
  </script>
</body></html>`
}

function _errorPage(message) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>Erro TikTok</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff5f5}</style>
</head>
<body>
  <div style="text-align:center">
    <h2 style="color:#c0392b">Erro ao conectar TikTok</h2>
    <p style="color:#666">${message}</p>
    <button onclick="window.close()" style="padding:8px 16px;cursor:pointer">Fechar</button>
  </div>
</body></html>`
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function verifyTikTokWebhookSignature({ header, payload, rawBody, clientSecret, toleranceSeconds }) {
  const signatureHeader = Array.isArray(header) ? header[0] : header

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing_signature' }
  }
  if (!clientSecret) {
    return { ok: false, reason: 'missing_client_secret' }
  }

  const parts = Object.fromEntries(
    signatureHeader
      .split(',')
      .map((item) => item.split('=').map((part) => part.trim()))
      .filter(([key, value]) => key && value)
  )
  const timestamp = parts.t
  const receivedSignature = parts.s

  if (!timestamp || !receivedSignature) {
    return { ok: false, reason: 'malformed_signature' }
  }

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'invalid_timestamp' }
  }

  if (!/^[a-f0-9]+$/i.test(receivedSignature)) {
    return { ok: false, reason: 'invalid_signature_format' }
  }

  const body = typeof rawBody === 'string'
    ? rawBody
    : JSON.stringify(payload ?? {})
  const expectedSignature = crypto
    .createHmac('sha256', clientSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')

  const received = Buffer.from(receivedSignature, 'hex')
  const expected = Buffer.from(expectedSignature, 'hex')

  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds)
  if (
    Number.isFinite(toleranceSeconds) &&
    toleranceSeconds > 0 &&
    ageSeconds > toleranceSeconds
  ) {
    return { ok: false, reason: 'expired_signature' }
  }

  return { ok: true }
}
