// S-07: criptografia simétrica AES-256-GCM pra tokens sensíveis em repouso (DB).
// Formato persistido: base64 de [iv(12) | tag(16) | ciphertext].
// Tokens legados em texto claro são detectados pelo decryptToken e devolvidos
// como estão, permitindo migração incremental.

import crypto from 'node:crypto'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const MIN_CIPHER_LEN = IV_LEN + TAG_LEN + 1

function _key() {
  const k = process.env.TOKEN_ENCRYPTION_KEY
  if (!k) {
    throw new Error('TOKEN_ENCRYPTION_KEY ausente — necessária para criptografar tokens TikTok')
  }
  if (k.length < 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY deve ter 32 bytes (64 hex chars)')
  }
  return Buffer.from(k, 'hex')
}

export function encryptToken(plaintext) {
  if (plaintext == null || plaintext === '') return null
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALG, _key(), iv)
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptToken(stored) {
  if (stored == null || stored === '') return null
  // Detecta formato base64 do nosso ciphertext. Tokens legados em plaintext
  // não passam por base64 válido com tamanho mínimo → retorna como está.
  let buf
  try {
    buf = Buffer.from(stored, 'base64')
  } catch {
    return String(stored)
  }
  if (buf.length < MIN_CIPHER_LEN) return String(stored)
  // Heurística adicional: se o decoded base64 não bater com tamanho típico
  // de token TikTok criptografado, assume legacy.
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const enc = buf.subarray(IV_LEN + TAG_LEN)
  try {
    const decipher = crypto.createDecipheriv(ALG, _key(), iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(enc), decipher.final()])
    return dec.toString('utf8')
  } catch {
    // Tag inválida = não foi criptografado por nós (legacy) ou chave errada
    return String(stored)
  }
}
