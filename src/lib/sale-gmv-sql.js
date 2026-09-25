/**
 * GMV e comissão de uma venda atribuída de live.
 *
 * A venda guarda uma cópia (vendas_atribuidas.gmv). Essa cópia não é fonte:
 * a leitura usa a mesma ordem de liveGmvSql (ads_gmv, manual_gmv, fat_gerado),
 * sem o piso 0 que transformaria "nada gravado" em zero. A proporção entre
 * as linhas da mesma live fica a do snapshot — quem tinha metade continua
 * com metade do GMV oficial. Snapshot 0 continua 0. Vídeo e live sem linha
 * continuam no gmv da própria venda.
 */

export function officialLiveGmvSql(alias = 'l') {
  return `CASE
    WHEN ${alias}.ads_gmv IS NULL AND ${alias}.manual_gmv IS NULL AND ${alias}.fat_gerado IS NULL THEN NULL
    ELSE COALESCE(${alias}.ads_gmv, ${alias}.manual_gmv, ${alias}.fat_gerado)
  END`
}

function lineSumSql(saleAlias) {
  return `(
    SELECT SUM(va_line.gmv)
      FROM vendas_atribuidas va_line
     WHERE va_line.tenant_id = ${saleAlias}.tenant_id
       AND va_line.origem = 'live'
       AND va_line.origem_id = ${saleAlias}.origem_id
       AND COALESCE(va_line.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
  )`
}

/** GMV da linha. Live: parte proporcional do GMV oficial. O resto: a coluna da venda. */
export function officialLineGmvExpr(saleAlias = 'va') {
  const sum = lineSumSql(saleAlias)
  const official = `(
    SELECT ${officialLiveGmvSql('live_row')}
      FROM lives live_row
     WHERE live_row.id = ${saleAlias}.origem_id
       AND live_row.tenant_id = ${saleAlias}.tenant_id
  )`
  return `CASE
    WHEN ${saleAlias}.origem IS DISTINCT FROM 'live' THEN ${saleAlias}.gmv
    WHEN ${saleAlias}.gmv IS NULL THEN NULL
    WHEN ${official} IS NULL THEN NULL
    WHEN COALESCE(${sum}, 0) = 0 THEN ${saleAlias}.gmv
    ELSE ${official} * ${saleAlias}.gmv / ${sum}
  END`
}

export function officialLinePctExpr(saleAlias = 'va') {
  const gmv = officialLineGmvExpr(saleAlias)
  const com = officialLineCommissionExpr(saleAlias, 'comissao_apresentadora')
  return `CASE WHEN (${gmv}) > 0
    THEN ROUND(((${com}) / (${gmv}) * 100)::numeric, 2)
    ELSE 0 END`
}

/** Comissão da linha na mesma proporção do GMV oficial. Zero gravado não é reescrito. GMV oficial ausente não vira zero. */
export function officialLineCommissionExpr(saleAlias = 'va', column = 'comissao_apresentadora') {
  const gmv = officialLineGmvExpr(saleAlias)
  return `CASE
    WHEN ${saleAlias}.origem IS DISTINCT FROM 'live' THEN ${saleAlias}.${column}
    WHEN ${saleAlias}.gmv IS NULL OR ${saleAlias}.gmv = 0 THEN ${saleAlias}.${column}
    WHEN (${gmv}) IS NULL THEN ${saleAlias}.${column}
    ELSE ${saleAlias}.${column} * (${gmv}) / ${saleAlias}.gmv
  END`
}

/**
 * Comissão já agregada de uma live, lida do GMV oficial.
 * O percentual continua o da venda (soma / gmv gravado): a taxa não muda,
 * a base muda.
 */
export function liveSaleCommissionLateralSql(live = 'l') {
  const official = officialLiveGmvSql(live)
  return `LEFT JOIN LATERAL (
           SELECT SUM(
                    CASE
                      WHEN va_c.gmv IS NULL OR va_c.gmv = 0 THEN va_c.comissao_apresentadora
                      WHEN (${official}) IS NULL THEN va_c.comissao_apresentadora
                      ELSE va_c.comissao_apresentadora * (${official}) / NULLIF(sale_total.gmv_sum, 0)
                    END
                  ) AS comissao_apresentadora,
                  ROUND(SUM(va_c.comissao_apresentadora) / NULLIF(SUM(va_c.gmv), 0) * 100, 2) AS pct_apresentadora
           FROM vendas_atribuidas va_c
           LEFT JOIN LATERAL (
             SELECT SUM(va_s.gmv) AS gmv_sum
               FROM vendas_atribuidas va_s
              WHERE va_s.tenant_id = ${live}.tenant_id
                AND va_s.origem = 'live'
                AND va_s.origem_id = ${live}.id
           ) sale_total ON true
           WHERE va_c.tenant_id = ${live}.tenant_id
             AND va_c.origem = 'live'
             AND va_c.origem_id = ${live}.id
         ) va_comissao ON true`
}

/** Escala uma comissão já somada quando o GMV gravado diverge do oficial. Oficial ausente não zera a comissão. */
export function scaledStoredCommissionSql(storedCommission, storedGmv, officialGmv) {
  return `CASE
    WHEN (${officialGmv}) IS NULL THEN COALESCE(${storedCommission}, 0)
    WHEN COALESCE(${storedGmv}, 0) = 0 THEN COALESCE(${storedCommission}, 0)
    ELSE COALESCE(${storedCommission}, 0) * (${officialGmv}) / ${storedGmv}
  END`
}
