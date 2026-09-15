/**
 * A live consolidada substitui seus trechos absorvidos nos leitores operacionais.
 * Uma união desfeita também deixa de contar o destino para que a reversão não
 * mantenha números duplicados enquanto restaura as origens.
 */
export function activeLiveSql(alias = 'l') {
  return `${alias}.uniao_destino_id IS NULL AND ${alias}.uniao_desfeita_em IS NULL`
}

/** Condição para JOIN opcional, preservando a linha da tabela à esquerda. */
export function activeLiveJoinSql(alias = 'l') {
  return `AND ${activeLiveSql(alias)}`
}
