const BUCKET = 'knowledge-private'

let state = { configured: false, ok: false }

function config() {
  return { base: process.env.SUPABASE_URL?.replace(/\/$/, ''), key: process.env.SUPABASE_SERVICE_KEY }
}

export function getKnowledgeStorageStatus() {
  return { ...state }
}

/**
 * Creates and verifies the private bucket without exposing provider responses.
 * Retries are opt-in so request paths stay single-attempt; boot supplies a small,
 * bounded backoff after the HTTP server is already accepting traffic.
 */
export async function ensureKnowledgePrivateBucket({
  fetchImpl = fetch,
  timeoutMs = 5000,
  retryDelays = [],
} = {}) {
  const { base, key } = config()
  if (!base || !key) {
    state = { configured: false, ok: false }
    return getKnowledgeStorageStatus()
  }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const request = (url, options = {}) => fetchImpl(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })

  for (let attempt = 0; ; attempt += 1) {
    try {
      const create = await request(`${base}/storage/v1/bucket`, {
        method: 'POST',
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
      })
      if (!create.ok && create.status !== 400 && create.status !== 409) throw new Error(`storage bucket create ${create.status}`)
      const check = await request(`${base}/storage/v1/bucket/${BUCKET}`)
      if (!check.ok) throw new Error(`storage bucket check ${check.status}`)
      const metadata = await check.json()
      if (metadata.public === true) throw new Error('knowledge-private bucket must be private')
      state = { configured: true, ok: true }
      return getKnowledgeStorageStatus()
    } catch (error) {
      state = {
        configured: true,
        ok: false,
        error: error?.name === 'TimeoutError' ? 'storage request timed out' : error.message,
      }
      if (attempt >= retryDelays.length) return getKnowledgeStorageStatus()
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]))
    }
  }
}

export { BUCKET as KNOWLEDGE_PRIVATE_BUCKET }
