import { z } from 'zod'

export const TIKTOK_USERNAME_RE = /^[a-zA-Z0-9_.]{2,24}$/

export const tiktokUsernameField = z
  .string()
  .trim()
  .refine((value) => !value.includes('@'), {
    message: 'Digite o TikTok sem @',
  })
  .refine((value) => value === '' || TIKTOK_USERNAME_RE.test(value), {
    message: 'tiktok_username inválido (2-24 chars: letras/números/_/.)',
  })
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional()

export function normalizeTikTokUsername(value) {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const username = value.trim()
  if (!username) return null
  if (username.includes('@')) return null
  return TIKTOK_USERNAME_RE.test(username) ? username : null
}

export function tiktokUsernameSql({ marca = null, cliente = null, contrato = null, live = null } = {}) {
  const values = []
  if (marca && cliente) {
    values.push(`CASE WHEN ${marca}.tipo = 'cliente' THEN ${cliente}.tiktok_username END`)
  }
  if (marca) {
    values.push(`CASE WHEN ${marca}.tipo IS DISTINCT FROM 'cliente' OR ${marca}.cliente_id IS NULL THEN ${marca}.tiktok_username END`)
  }
  if (cliente) values.push(`${cliente}.tiktok_username`)
  if (marca) values.push(`${marca}.tiktok_username`)
  if (contrato) values.push(`${contrato}.tiktok_username`)
  if (live) values.push(`${live}.tiktok_username`)
  if (values.length === 0) return 'NULL'
  return `COALESCE(${values.join(', ')})`
}

export async function updateCanonicalTikTokUsername(db, { tenantId, username, marcaId = null, clienteId = null, contratoId = null }) {
  if (username === undefined) return null
  const normalized = normalizeTikTokUsername(username)

  if (marcaId) {
    const marcaQ = await db.query(
      `SELECT id, tipo, cliente_id
       FROM marcas
       WHERE id = $1 AND tenant_id = $2::uuid`,
      [marcaId, tenantId],
    )
    const marca = marcaQ.rows[0]
    if (!marca) return null

    if (marca.tipo === 'cliente' && marca.cliente_id) {
      await db.query(
        `UPDATE clientes
         SET tiktok_username = $1, atualizado_em = NOW()
         WHERE id = $2 AND tenant_id = $3::uuid`,
        [normalized, marca.cliente_id, tenantId],
      )
      return { source: 'cliente', id: marca.cliente_id, tiktok_username: normalized }
    }

    await db.query(
      `UPDATE marcas
       SET tiktok_username = $1, atualizado_em = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid`,
      [normalized, marca.id, tenantId],
    )
    return { source: 'marca', id: marca.id, tiktok_username: normalized }
  }

  if (clienteId) {
    await db.query(
      `UPDATE clientes
       SET tiktok_username = $1, atualizado_em = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid`,
      [normalized, clienteId, tenantId],
    )
    return { source: 'cliente', id: clienteId, tiktok_username: normalized }
  }

  if (contratoId) {
    const contratoQ = await db.query(
      `SELECT cliente_id
       FROM contratos
       WHERE id = $1 AND tenant_id = $2::uuid`,
      [contratoId, tenantId],
    )
    const contrato = contratoQ.rows[0]
    if (!contrato?.cliente_id) return null
    await db.query(
      `UPDATE clientes
       SET tiktok_username = $1, atualizado_em = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid`,
      [normalized, contrato.cliente_id, tenantId],
    )
    return { source: 'cliente', id: contrato.cliente_id, tiktok_username: normalized }
  }

  return null
}
