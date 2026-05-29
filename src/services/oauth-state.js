// src/services/oauth-state.js
// CSRF signed state pra OAuth flows (TikTok Live + TikTok Shop).
// Formato: `tenantId:nonce:timestamp:hmacSig16`
// Assinado com HMAC-SHA256 usando OAUTH_STATE_SECRET (S-13: secret dedicado,
// fallback pra JWT_SECRET pra compat com deploys antigos).

import crypto from 'node:crypto'

const DEFAULT_MAX_AGE_MS = 10 * 60_000 // 10 minutos

function _secret() {
  const s = process.env.OAUTH_STATE_SECRET ?? process.env.JWT_SECRET
  if (!s || s.length < 32) {
    throw new Error('OAUTH_STATE_SECRET (ou fallback JWT_SECRET) não configurado ou muito curto (mínimo 32 chars)')
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

  let expected
  try {
    expected = _sign(payload)
  } catch {
    return null
  }

  // Comparação timing-safe
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

  const ts = Number(tsStr)
  if (!Number.isFinite(ts)) return null
  if (Date.now() - ts > maxAgeMs) return null

  return { tenantId, nonce, ts }
}
