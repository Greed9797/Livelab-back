/**
 * Serviço de cálculo de comissões.
 *
 * Dois tipos de comissão convivem sem sobreposição:
 *   - LiveLab  → derivada de contratos.comissao_pct  (registrada em lives.comissao_calculada)
 *   - Apresentadora → derivada de apresentadoras.comissao_pct, com override de 2 % em fins de
 *                     semana (registrada em lives.comissao_apresentadora_pct / valor)
 *
 * Todas as funções são puras: sem efeitos colaterais, sem mutação, sem I/O.
 */

/**
 * Retorna true se `date` cair em sábado ou domingo no fuso America/Sao_Paulo.
 *
 * @param {Date} date
 * @returns {boolean}
 */
export function isFimDeSemanaSP(date) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
  }).format(date)
  // 'Sat' ou 'Sun'
  return weekday === 'Sat' || weekday === 'Sun'
}

/**
 * Calcula a comissão da apresentadora de acordo com as regras de negócio:
 *   - Se não há apresentadora vinculada (`temApresentadora = false`), retorna null/null.
 *   - Se a live iniciou em fim de semana (America/Sao_Paulo), pct = 2 (override fixo).
 *   - Caso contrário, usa `apresentadoraPct` do cadastro.
 *   - Se `apresentadoraPct` é null E não é fim de semana → sem apresentadora cadastrada com pct
 *     mas a apresentadora existe: pct fica null (nenhum valor negociado), valor null.
 *
 * @param {{
 *   fatGerado: number,
 *   apresentadoraPct: number | null,
 *   iniciadoEm: Date,
 *   temApresentadora: boolean
 * }} params
 * @returns {{ pct: number | null, valor: number | null }}
 */
export function calcularComissaoApresentadora({ fatGerado, apresentadoraPct, iniciadoEm, temApresentadora }) {
  if (!temApresentadora) {
    return { pct: null, valor: null }
  }

  const fimDeSemana = isFimDeSemanaSP(iniciadoEm)

  if (!fimDeSemana && apresentadoraPct == null) {
    return { pct: null, valor: null }
  }

  const pct = fimDeSemana ? 2 : Number(apresentadoraPct)
  const valor = Math.round(fatGerado * (pct / 100) * 100) / 100

  return { pct, valor }
}

/**
 * Calcula a comissão LiveLab (empresa) — lógica extraída dos 3 pontos de cabines.js.
 * Semanticamente idêntica ao comportamento anterior: nenhuma alteração de resultado.
 *
 * @param {{ fatGerado: number, contratoPct: number | null }} params
 * @returns {{ pct: number, valor: number }}
 */
export function calcularComissaoLivelab({ fatGerado, contratoPct }) {
  const pct = Number(contratoPct ?? 0)
  const valor = Math.round(fatGerado * (pct / 100) * 100) / 100
  return { pct, valor }
}
