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

/**
 * Horas de PRESENÇA de uma apresentadora numa live — régua separada da de cima, de propósito.
 *
 * `apresentadoraHorasSql` mede PRODUTIVIDADE e está certa para o que faz: alimenta GMV/h, meta
 * e ranking, e por isso usa `percentual_rateio`. Só que percentual_rateio é instrumento de
 * dividir DINHEIRO: no rateio pós-live por valor ele sai de `gmv/gmvTotal`
 * (src/lib/live-rateio.js, distribuirPercentuais), então quem ficou 6h no ar e vendeu R$ 0
 * recebe percentual 0,00 → 0 hora → o painel de assiduidade a acusa de não ter aparecido.
 * Medir PRESENÇA com a régua do dinheiro é o falso positivo mais caro desta tela.
 *
 * A cascata aqui é de sinais de TEMPO, do mais forte para o mais fraco:
 *   1. `segundos_rateio` — tempo medido de verdade, informado na revisão do rateio.
 *      NULLIF(...,0) porque zero ali nunca é "ela ficou zero segundo": vem de live importada com
 *      encerrado_em = iniciado_em (duração 0) ou de campo em branco. Zero é ausência de
 *      informação, e ausência de informação não pode ganhar do resto da cascata.
 *   2. o turno dela em `agenda_evento_apresentadoras` — é tempo de calendário, imune ao rateio.
 *      Resolve a co-apresentação: dois turnos SOBREPOSTOS de 5h numa live de 5h dão percentual
 *      50/50 (o denominador de calcularRateioPlanejado é a SOMA dos turnos), e pelo percentual
 *      cada uma levaria 2,5h de uma live em que ficou 5h. Pelo turno, cada uma leva as 5h dela.
 *      Capado pela duração da live para o plano não inventar hora que não houve. O CASE em
 *      volta do LEAST não é decoração: `LEAST(NULL, 5.0)` é 5.0 no Postgres, então sem ele toda
 *      live SEM turno cairia neste degrau com a duração cheia e engoliria os degraus 3 e 4.
 *   3. duração × `percentual_rateio` SÓ quando o rateio é PLANEJADO (`gmv_rateado IS NULL`, a
 *      assinatura do seed de agenda-turnos.js): ali o percentual veio do TEMPO dos turnos, então
 *      é sinal de tempo legítimo — e é o que mantém o revezamento sequencial correto.
 *   4. rateio de DINHEIRO sem tempo informado: o percentual não diz nada sobre presença. Ter
 *      linha na live já prova presença, então credita-se a live inteira.
 * Sem linha nenhuma sobra a live inteira: é o caso mono-apresentadora, igual à régua de cima.
 */
export function apresentadoraHorasPresencaSql({ live = 'l', rateio = 'ap_v2', turno = 'turno' } = {}) {
  // Duração blindada, diferente da régua de produtividade: o CASE devolve 0 quando a live não
  // tem fim conhecido ou tem fim ANTES do início. Sem ele, `LEAST(NULL, 24.0)` é 24.0 no
  // Postgres (LEAST ignora NULL) e uma live sem encerrado_em creditaria 24h; e encerrado_em
  // corrompido (migration 107 documenta o caso em produção) creditaria hora negativa, que
  // subtrai as horas de outra live do mesmo dia e fabrica vermelho.
  const duracaoCapada = `CASE
              WHEN COALESCE(${live}.encerrado_em, ${live}.previsto_fim) > ${live}.iniciado_em
                THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(${live}.encerrado_em, ${live}.previsto_fim) - ${live}.iniciado_em)) / 3600.0, 24.0)
              ELSE 0 END`
  return `CASE
          WHEN ${rateio}.apresentadora_id IS NOT NULL
            THEN COALESCE(
              NULLIF(${rateio}.segundos_rateio, 0) / 3600.0,
              CASE WHEN ${turno}.horas_turno IS NOT NULL
                   THEN LEAST(${turno}.horas_turno, ${duracaoCapada}) END,
              CASE WHEN ${rateio}.gmv_rateado IS NULL
                   THEN ${duracaoCapada} * ${rateio}.percentual_rateio / 100.0 END,
              ${duracaoCapada}
            )
          ELSE ${duracaoCapada}
        END`
}
