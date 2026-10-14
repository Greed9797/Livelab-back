import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { errors } from 'oidc-provider'

export const artifactHash = value => createHash('sha256').update(String(value)).digest('hex')

// O adapter guarda artefatos globais do provedor, nunca dados de operação de tenants.
export function createOAuthAdapter(db, storageKey) {
  const key = storageKey && Buffer.from(storageKey, 'base64')
  const encode = payload => {
    if (!key || key.length !== 32) throw new Error('MCP_STORAGE_KEY inválida')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
  }
  const decode = value => {
    const bytes = Buffer.from(value, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString())
  }
  return class OAuthAdapter {
    constructor(model) { this.model = model }
    async upsert(id, payload, expiresIn) {
      await db.query(`INSERT INTO mcp_oauth_artifacts
        (model, id_hash, payload, expires_at, grant_hash, uid_hash, user_code_hash)
        VALUES ($1, $2, $3, NOW() + ($4 * interval '1 second'), $5, $6, $7)
        ON CONFLICT (model, id_hash) DO UPDATE SET payload = EXCLUDED.payload,
          expires_at = EXCLUDED.expires_at, grant_hash = EXCLUDED.grant_hash,
          uid_hash = EXCLUDED.uid_hash, user_code_hash = EXCLUDED.user_code_hash`,
      [this.model, artifactHash(id), encode(payload), expiresIn || 86400,
        payload.grantId ? artifactHash(payload.grantId) : null,
        payload.uid ? artifactHash(payload.uid) : null,
        payload.userCode ? artifactHash(payload.userCode) : null])
    }
    async lookup(column, value) {
      const result = await db.query(`SELECT payload, consumed_at FROM mcp_oauth_artifacts
        WHERE model = $1 AND ${column} = $2 AND expires_at > NOW()`, [this.model, artifactHash(value)])
      if (!result.rows[0]) return undefined
      const payload = decode(result.rows[0].payload)
      if (result.rows[0].consumed_at) payload.consumed = Math.floor(new Date(result.rows[0].consumed_at).getTime() / 1000)
      return payload
    }
    find(id) { return this.lookup('id_hash', id) }
    findByUid(uid) { return this.lookup('uid_hash', uid) }
    findByUserCode(code) { return this.lookup('user_code_hash', code) }
    async consume(id) {
      const result = await db.query('UPDATE mcp_oauth_artifacts SET consumed_at = NOW() WHERE model = $1 AND id_hash = $2 AND consumed_at IS NULL RETURNING id_hash', [this.model, artifactHash(id)])
      if (result.rowCount === 0) throw new errors.InvalidGrant('Artefato já consumido ou revogado')
    }
    async destroy(id) {
      await db.query('DELETE FROM mcp_oauth_artifacts WHERE model = $1 AND id_hash = $2', [this.model, artifactHash(id)])
    }
    async revokeByGrantId(id) {
      await db.query('DELETE FROM mcp_oauth_artifacts WHERE grant_hash = $1 OR (model = \'Grant\' AND id_hash = $1)', [artifactHash(id)])
      await db.query('DELETE FROM mcp_oauth_bindings WHERE grant_hash = $1', [artifactHash(id)])
    }
  }
}
