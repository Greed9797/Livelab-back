const BUCKET = 'knowledge-private'

let state = { configured: false, ok: false }

function config() {
  return { base: process.env.SUPABASE_URL?.replace(/\/$/, ''), key: process.env.SUPABASE_SERVICE_KEY }
}

export function getKnowledgeStorageStatus() {
  return { ...state }
}

/**
 * Creates the private bucket once at boot and verifies existing buckets instead
 * of assuming a 409 means it has the desired visibility. No key or provider
 * response is returned to callers.
 */
export async function ensureKnowledgePrivateBucket({ fetchImpl = fetch } = {}) {
  const { base, key } = config()
  if (!base || !key) {
    state = { configured: false, ok: false }
    return state
  }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  try {
    const create = await fetchImpl(`${base}/storage/v1/bucket`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
    })
    if (!create.ok && create.status !== 409) throw new Error(`storage bucket create ${create.status}`)
    const check = await fetchImpl(`${base}/storage/v1/bucket/${BUCKET}`, { headers })
    if (!check.ok) throw new Error(`storage bucket check ${check.status}`)
    const metadata = await check.json()
    if (metadata.public === true) throw new Error('knowledge-private bucket must be private')
    state = { configured: true, ok: true }
  } catch (error) {
    state = { configured: true, ok: false, error: error.message }
  }
  return getKnowledgeStorageStatus()
}

export { BUCKET as KNOWLEDGE_PRIVATE_BUCKET }
