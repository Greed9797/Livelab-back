export function liveGmvSql(alias = 'l') {
  return `COALESCE(${alias}.ads_gmv, ${alias}.manual_gmv, ${alias}.fat_gerado, 0)`
}

export function liveOrdersSql(alias = 'l') {
  return `COALESCE(${alias}.manual_orders, ${alias}.final_orders_count, 0)`
}

/**
 * Horas de uma live — mesma expressão de src/routes/home.js e src/routes/analytics.js.
 *
 * `previsto_fim` cobre a live que ninguém encerrou; sem ele a duração vira 0 e some do total.
 * O teto de 24h impede que uma live esquecida aberta invente centenas de horas no painel.
 */
export function liveHoursSql(alias = 'l') {
  return `LEAST(GREATEST(EXTRACT(EPOCH FROM (COALESCE(${alias}.encerrado_em, ${alias}.previsto_fim) - ${alias}.iniciado_em)) / 3600, 0), 24)`
}
