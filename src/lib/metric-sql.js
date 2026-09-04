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

/**
 * Horas de live creditadas a UMA apresentadora — a expressão canônica do sistema, extraída do
 * ramo groupBy='apresentadora' de performance-rollups.js, a única cópia que trata revezamento
 * certo. Exige um LATERAL sobre live_apresentadoras_v2 SEM `LIMIT 1`: com LIMIT 1 a apoio some
 * do dia e a principal fica com 100% das horas.
 *
 * A cascata tem três degraus e a ordem importa:
 *   1. `segundos_rateio` — rateio fechado depois da live, tempo medido de verdade.
 *   2. duração capada × `percentual_rateio` — o rateio PLANEJADO grava só o percentual e deixa
 *      segundos_rateio NULL de propósito, para as horas se autocorrigirem quando a live encerra
 *      (ver agenda-turnos.js). Nunca assumir segundos_rateio preenchido.
 *   3. papel='principal' leva a live inteira — cobre a linha antiga, sem rateio nenhum.
 * Sem linha em live_apresentadoras_v2 sobra a live inteira: é o caso mono-apresentadora.
 *
 * `previsto_fim` cobre a live que ninguém encerrou (sem ele a duração vira 0 e some do total) e
 * o teto de 24h impede que uma live esquecida aberta invente centenas de horas no painel.
 *
 * A indentação embutida existe para o texto gerado bater byte a byte com o SQL que já estava
 * inline em performance-rollups.js — a extração não podia mexer em número nenhum.
 */
export function apresentadoraHorasSql({ live = 'l', rateio = 'ap_v2' } = {}) {
  const duracaoCapada = `LEAST(EXTRACT(EPOCH FROM (COALESCE(${live}.encerrado_em, ${live}.previsto_fim) - ${live}.iniciado_em)) / 3600.0, 24.0)`
  return `CASE
          WHEN ${rateio}.apresentadora_id IS NOT NULL
            THEN COALESCE(
              ${rateio}.segundos_rateio / 3600.0,
              ${duracaoCapada} * ${rateio}.percentual_rateio / 100.0,
              CASE WHEN ${rateio}.papel = 'principal' THEN ${duracaoCapada} ELSE 0 END
            )
          WHEN COALESCE(${live}.encerrado_em, ${live}.previsto_fim) > ${live}.iniciado_em
            THEN ${duracaoCapada}
          ELSE 0
        END`
}
