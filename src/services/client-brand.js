/**
 * Invariante operacional: TODO cliente possui exatamente uma marca tipo='cliente'.
 *
 * É nessa marca que vivem os percentuais e o fixo mensal de comissão da franquia
 * (marcas.comissao_franquia_pct / comissao_franqueadora_pct / valor_fixo_minimo).
 * Sem a marca, o commission-engine não resolve comissão e a live some das somas.
 *
 * `ensureClienteMarca` é idempotente: reaproveita a marca existente (reativando-a
 * se necessário) ou cria uma nova a partir dos dados do cliente. É o ÚNICO ponto
 * de criação da marca-espelho do cliente — `agenda.js` e `lives.js` delegam aqui
 * em vez de duplicar a lógica (evita marcas duplicadas por cliente).
 */
export async function ensureClienteMarca(
  db,
  { tenantId, clienteId, activateExisting = true, observacoes = 'Marca de cliente criada automaticamente.' } = {},
) {
  if (!tenantId || !clienteId) return null

  // Pega a marca preferida do cliente (ativa > mais recente) de forma determinística.
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
    `SELECT id, nome, site, logo_url
       FROM clientes
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid`,
    [clienteId, tenantId],
  )
  const row = cliente.rows[0]
  if (!row) return null

  // tiktok_username fica NULL em marca tipo='cliente': o cliente é a fonte canônica
  // do @ (ver migration 103 e tiktokUsernameSql, precedência cliente>marca). Copiar
  // aqui criaria @ desatualizado se o cliente trocar o usuário depois.
  const inserted = await db.query(
    `INSERT INTO marcas (
       tenant_id, cliente_id, nome, tipo, status, tiktok_username, site, logo_url, observacoes
     )
     VALUES ($1,$2,$3,'cliente','ativa',NULL,$4,$5,$6)
     RETURNING id`,
    [
      tenantId,
      row.id,
      row.nome,
      row.site ?? null,
      row.logo_url ?? null,
      observacoes,
    ],
  )
  return inserted.rows[0]?.id ?? null
}
