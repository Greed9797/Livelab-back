/**
 * Invariante operacional: TODO cliente possui exatamente uma marca tipo='cliente'.
 *
 * É nessa marca que vivem os percentuais e o fixo mensal de comissão da franquia
 * (marcas.comissao_franquia_pct / comissao_franqueadora_pct / valor_fixo_minimo).
 * Sem a marca, o commission-engine não resolve comissão e a live some das somas.
 *
 * `ensureClienteMarca` é idempotente: reaproveita a marca existente sem alterar
 * seu ciclo de vida por padrão, ou cria uma nova a partir dos dados do cliente. É o ÚNICO ponto
 * de criação da marca-espelho do cliente — `agenda.js` e `lives.js` delegam aqui
 * em vez de duplicar a lógica (evita marcas duplicadas por cliente).
 */
export async function ensureClienteMarca(
  db,
  { tenantId, clienteId, activateExisting = false, observacoes = 'Marca de cliente criada automaticamente.', origem = 'manual' } = {},
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
      // Reativação é uma ação explícita do cliente. Nunca ressuscita uma marca
      // espelho se o cliente já está cancelado ou arquivado.
      const cliente = await db.query(
        `SELECT status
           FROM clientes
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid`,
        [clienteId, tenantId],
      )
      if (!cliente.rows[0] || ['cancelado', 'cancelado_automaticamente', 'arquivado'].includes(cliente.rows[0].status)) {
        return marca.id
      }
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
    `SELECT id, nome, site, logo_url, status
       FROM clientes
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid`,
    [clienteId, tenantId],
  )
  const row = cliente.rows[0]
  if (!row) return null

  const statusMarca = row.status === 'arquivado'
    ? 'arquivada'
    : ['cancelado', 'cancelado_automaticamente'].includes(row.status)
      ? 'inativa'
      : 'ativa'

  // tiktok_username fica NULL em marca tipo='cliente': o cliente é a fonte canônica
  // do @ (ver migration 103 e tiktokUsernameSql, precedência cliente>marca). Copiar
  // aqui criaria @ desatualizado se o cliente trocar o usuário depois.
  const inserted = await db.query(
    `INSERT INTO marcas (
       tenant_id, cliente_id, nome, tipo, status, tiktok_username, site, logo_url, observacoes, origem_dados
     )
     VALUES ($1,$2,$3,'cliente',$4,NULL,$5,$6,$7,$8)
     RETURNING id`,
    [
      tenantId,
      row.id,
      row.nome,
      statusMarca,
      row.site ?? null,
      row.logo_url ?? null,
      observacoes,
      origem,
    ],
  )
  return inserted.rows[0]?.id ?? null
}
