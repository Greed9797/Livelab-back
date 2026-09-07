// Regra compartilhada de rateio de fixo por competência. Financeiro operacional e
// fechamento/PDF devem calcular o mesmo mês fechado, inclusive entrada/saída no meio dele.
export function prorateFatorSql(mesExpr, inicioCol, fimCol) {
  const ini = `(${mesExpr})::date`
  const fim = `((${mesExpr}) + interval '1 month' - interval '1 day')::date`
  return `GREATEST(0, LEAST(1.0,
    (LEAST(${fim}, COALESCE(${fimCol}, ${fim})) - GREATEST(${ini}, COALESCE(${inicioCol}, ${ini})) + 1)::numeric
    / EXTRACT(DAY FROM (${fim}))::numeric
  ))`
}
