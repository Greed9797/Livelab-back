export const DEFAULT_APRESENTADORA_FIXO = 2700
export const MAX_APRESENTADORA_FIXO = 10000

// Piso/teto do fixo mensal aplicado a QUALQUER expressão: valor ausente, zerado ou
// acima do teto vira o padrão. Extraído para que o valor histórico (migration 137)
// passe exatamente pela mesma normalização do valor de cadastro — duas regras
// diferentes dariam dois números para a mesma apresentadora.
export function presenterFixedCapSql(expr) {
  return `CASE WHEN COALESCE(${expr}, 0) <= 0 OR (${expr}) > ${MAX_APRESENTADORA_FIXO} THEN ${DEFAULT_APRESENTADORA_FIXO} ELSE (${expr}) END`
}

export function presenterFixedSql(alias = 'a') {
  return presenterFixedCapSql(alias ? `${alias}.fixo` : 'fixo')
}

// Fixo VIGENTE numa data — para relatórios de período fechado (migration 137).
//
// dataRefExpr precisa ser uma data INCLUSIVA (o último dia que o relatório cobre).
// Isso não é detalhe de estilo: performance-rollups e comissoes trabalham com fim
// EXCLUSIVO (`va.data < $3`) e o financeiro com fim inclusivo. Sem normalizar, um
// reajuste feito no dia 1º de setembro entraria no fechamento de AGOSTO em uma tela
// e não na outra — dois números para o mesmo mês fechado.
//
// COALESCE com a coluna atual antes do cap: apresentadora sem linha de histórico
// (criada fora do trigger, banco restaurado pela metade) cai no valor de cadastro,
// que é o comportamento de antes. Nunca devolve 0 nem inventa o padrão.
export function presenterFixedAtSql(alias, dataRefExpr) {
  const a = alias || 'a'
  return presenterFixedCapSql(`COALESCE((
    SELECT h.valor
      FROM apresentadora_fixo_historico h
     WHERE h.tenant_id = ${a}.tenant_id
       AND h.apresentadora_id = ${a}.id
       AND h.vigencia_inicio <= (${dataRefExpr})
     ORDER BY h.vigencia_inicio DESC, h.id DESC
     LIMIT 1
  ), ${a}.fixo)`)
}

// Fallback de ÚLTIMO recurso — a fonte EDITÁVEL da escada padrão é a tabela
// tenant_comissao_faixas_default (endpoints /v1/comissoes/faixas-default).
// Este array só vale quando o tenant ainda não tem nenhuma linha lá.
export const DEFAULT_APRESENTADORA_COMISSAO_FAIXAS = [
  { gmv_inicio: 0, gmv_fim: 70000, comissao_pct: 1 },
  { gmv_inicio: 70000.01, gmv_fim: 150000, comissao_pct: 1.5 },
  { gmv_inicio: 150000.01, gmv_fim: null, comissao_pct: 2 },
]

export function defaultPresenterCommissionPct(gmv) {
  const value = Number(gmv ?? 0)
  const tier = DEFAULT_APRESENTADORA_COMISSAO_FAIXAS.find((faixa) => {
    const startOk = value >= faixa.gmv_inicio
    const endOk = faixa.gmv_fim === null || value <= faixa.gmv_fim
    return startOk && endOk
  })
  return tier?.comissao_pct ?? 0
}

// Escada padrão do tenant (tenant_comissao_faixas_default) — fonte editável.
// Sem linha no banco → escada do código (DEFAULT_APRESENTADORA_COMISSAO_FAIXAS).
export async function getTenantDefaultCommissionTiers(db, tenantId) {
  if (!tenantId) return DEFAULT_APRESENTADORA_COMISSAO_FAIXAS
  const result = await db.query(
    `SELECT gmv_inicio, gmv_fim, comissao_pct
     FROM tenant_comissao_faixas_default
     WHERE tenant_id = $1::uuid
     ORDER BY gmv_inicio ASC`,
    [tenantId],
  )
  if (!result.rows.length) return DEFAULT_APRESENTADORA_COMISSAO_FAIXAS
  return result.rows.map((row) => ({
    gmv_inicio: Number(row.gmv_inicio),
    gmv_fim: row.gmv_fim === null ? null : Number(row.gmv_fim),
    comissao_pct: Number(row.comissao_pct),
  }))
}

export async function ensureDefaultPresenterCommissionTiers(db, tenantId, apresentadoraId) {
  if (!tenantId || !apresentadoraId) return

  const existing = await db.query(
    `SELECT id
     FROM apresentadora_comissao_faixas
     WHERE tenant_id = $1::uuid
       AND apresentadora_id = $2::uuid
       AND ativo = true
     LIMIT 1`,
    [tenantId, apresentadoraId],
  )
  if (existing.rows[0]) return

  // Semeia a partir do padrão do tenant (não mais do array hardcoded).
  const tiers = await getTenantDefaultCommissionTiers(db, tenantId)
  const values = [tenantId, apresentadoraId]
  const tuples = tiers.map((faixa) => {
    const base = values.length
    values.push(faixa.gmv_inicio, faixa.gmv_fim, faixa.comissao_pct)
    return `($1::uuid, $2::uuid, $${base + 1}::numeric, $${base + 2}::numeric, $${base + 3}::numeric, true)`
  }).join(', ')

  await db.query(
    `INSERT INTO apresentadora_comissao_faixas (
       tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo
     )
     VALUES ${tuples}`,
    values,
  )
}
