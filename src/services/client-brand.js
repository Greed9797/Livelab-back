export async function ensureClienteMarca(
  db,
  { tenantId, clienteId, activateExisting = true, observacoes = 'Marca de cliente criada automaticamente.' } = {},
) {
  if (!tenantId || !clienteId) return null

  const existing = await db.query(
    `SELECT id, status
       FROM marcas
      WHERE tenant_id = $1::uuid
        AND cliente_id = $2::uuid
        AND tipo = 'cliente'
      ORDER BY (status = 'ativa') DESC, atualizado_em DESC NULLS LAST, criado_em ASC
      LIMIT 1`,
    [tenantId, clienteId],
  )
  const marca = existing.rows[0]
  if (marca) {
    if (activateExisting && marca.status !== 'ativa') {
      const updated = await db.query(
        `UPDATE marcas
            SET status = 'ativa',
                atualizado_em = NOW()
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid
          RETURNING id`,
        [marca.id, tenantId],
      )
      return updated.rows[0]?.id ?? marca.id
    }
    return marca.id
  }

  const cliente = await db.query(
    `SELECT id, nome, tiktok_username, site, logo_url
       FROM clientes
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid`,
    [clienteId, tenantId],
  )
  const row = cliente.rows[0]
  if (!row) return null

  const inserted = await db.query(
    `INSERT INTO marcas (
       tenant_id, cliente_id, nome, tipo, status, tiktok_username, site, logo_url, observacoes
     )
     VALUES ($1,$2,$3,'cliente','ativa',$4,$5,$6,$7)
     RETURNING id`,
    [
      tenantId,
      row.id,
      row.nome,
      row.tiktok_username ?? null,
      row.site ?? null,
      row.logo_url ?? null,
      observacoes,
    ],
  )
  return inserted.rows[0]?.id ?? null
}
