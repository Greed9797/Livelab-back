export function liveGmvSql(alias = 'l') {
  return `COALESCE(${alias}.ads_gmv, ${alias}.manual_gmv, ${alias}.fat_gerado, 0)`
}

export function liveOrdersSql(alias = 'l') {
  return `COALESCE(${alias}.manual_orders, ${alias}.final_orders_count, 0)`
}
