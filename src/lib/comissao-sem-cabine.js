/**
 * Comissão da live quando não há cabine (e portanto não há contrato da cabine).
 *
 * Ordem: percentual da condição vigente quando é maior que zero, senão
 * marcas.comissao_franquia_pct quando foi de fato informado (> 0) e, se essa
 * fonte não existe, a faixa da apresentadora (própria, senão padrão do tenant).
 *
 * Zero não entra. A coluna nasce com DEFAULT 0, e a role do portal não pode
 * ler comissao_confirmada (revogada na migration 156) — selecioná-la no aprovar
 * estoura 42501. Fonte ausente devolve null. Não devolve 0 para inventar comissão.
 * comissao_franqueadora (royalty) fica de fora — o placeholder 0 dela não entra aqui.
 */

export async function resolveComissaoPctSemCabine(db, {
  tenantId,
  marcaId = null,
  apresentadoraId = null,
  gmv = 0,
  data = null,
} = {}) {
  const marcaPct = await marcaFranquiaPct(db, { tenantId, marcaId, data })
  if (marcaPct != null) return marcaPct

  return apresentadoraTierPct(db, { tenantId, apresentadoraId, gmv, data })
}

export function comissaoValorFromPct(gmv, pct) {
  if (pct == null || pct === '') return null
  const percent = Number(pct)
  if (!Number.isFinite(percent)) return null
  return Number(gmv ?? 0) * (percent / 100)
}

async function marcaFranquiaPct(db, { tenantId, marcaId, data }) {
  if (!marcaId) return null

  const result = await db.query(
    `SELECT
       CASE
         WHEN mc.comissao_franquia_pct > 0 THEN mc.comissao_franquia_pct
         ELSE NULL
       END AS condicao_pct,
       m.comissao_franquia_pct AS marca_pct
     FROM marcas m
     LEFT JOIN LATERAL (
       SELECT c.comissao_franquia_pct
         FROM marca_condicoes_comerciais c
        WHERE c.tenant_id = m.tenant_id
          AND c.marca_id = m.id
          AND c.inicio_vigencia <= COALESCE($3::date, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
          AND c.cancelled_at IS NULL
        ORDER BY c.inicio_vigencia DESC
        LIMIT 1
     ) mc ON true
     WHERE m.id = $1::uuid
       AND m.tenant_id = $2::uuid`,
    [marcaId, tenantId, data],
  )
  const row = result.rows[0]
  if (!row) return null
  if (row.condicao_pct != null && row.condicao_pct !== '') return Number(row.condicao_pct)
  // DEFAULT 0 da coluna é placeholder, não percentual negociado.
  // Um valor acima de zero na marca é fonte real mesmo sem a flag da condição.
  if (row.marca_pct != null && row.marca_pct !== '' && Number(row.marca_pct) > 0) {
    return Number(row.marca_pct)
  }
  return null
}

async function apresentadoraTierPct(db, { tenantId, apresentadoraId, gmv, data }) {
  if (!apresentadoraId) return null

  const baseQ = data
    ? await db.query(
      `SELECT COALESCE(SUM(gmv), 0) AS gmv_mes
         FROM vendas_atribuidas
        WHERE tenant_id = $1::uuid
          AND apresentadora_id = $2::uuid
          AND date_trunc('month', data::timestamp) = date_trunc('month', $3::date::timestamp)`,
      [tenantId, apresentadoraId, data],
    )
    : { rows: [{ gmv_mes: 0 }] }
  const baseGmv = Number(baseQ.rows[0]?.gmv_mes ?? 0) + Number(gmv ?? 0)
  if (!Number.isFinite(baseGmv)) return null

  const faixa = await db.query(
    `SELECT comissao_pct
       FROM apresentadora_comissao_faixas
      WHERE tenant_id = $1::uuid
        AND apresentadora_id = $2::uuid
        AND ativo = true
        AND gmv_inicio <= $3::numeric
        AND (gmv_fim IS NULL OR gmv_fim >= $3::numeric)
      ORDER BY gmv_inicio DESC
      LIMIT 1`,
    [tenantId, apresentadoraId, baseGmv],
  )
  if (faixa.rows[0]?.comissao_pct != null && faixa.rows[0].comissao_pct !== '') {
    return Number(faixa.rows[0].comissao_pct)
  }

  const tenantDefault = await db.query(
    `SELECT comissao_pct
       FROM tenant_comissao_faixas_default
      WHERE tenant_id = $1::uuid
        AND gmv_inicio <= $2::numeric
        AND (gmv_fim IS NULL OR gmv_fim >= $2::numeric)
      ORDER BY gmv_inicio DESC
      LIMIT 1`,
    [tenantId, baseGmv],
  )
  if (tenantDefault.rows[0]?.comissao_pct != null && tenantDefault.rows[0].comissao_pct !== '') {
    return Number(tenantDefault.rows[0].comissao_pct)
  }
  return null
}
