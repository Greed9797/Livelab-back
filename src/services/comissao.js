/**
 * Serviço de cálculo de comissões — snapshot operacional por live.
 *
 * Dois tipos de comissão convivem sem sobreposição:
 *   - LiveLab  → derivada de contratos.comissao_pct  (registrada em lives.comissao_calculada)
 *   - Apresentadora → derivada de apresentadoras.comissao_pct, com override de 2 % em fins de
 *                     semana (registrada em lives.comissao_apresentadora_pct / valor)
 *
 * Todas as funções são puras: sem efeitos colaterais, sem mutação, sem I/O.
 *
 * NOTA: Em produção há um sistema de faixas (apresentadora_comissao_faixas /
 * vendas_atribuidas, migration 088) gerido por commission-engine.js. Os campos
 * comissao_apresentadora_pct/valor por live são o snapshot operacional do painel
 * do cliente — reconciliação faixas×fds é responsabilidade do commission-engine.
 */

/**
 * Retorna true se `date` cair em sábado ou domingo no fuso America/Sao_Paulo.
 *
 * Aceita Date, string ISO-8601 ou timestamp numérico.
 *
 * @param {Date | string | number} date
 * @returns {boolean}
 */
export function isFimDeSemanaSP(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return false
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
  }).format(d)
  // 'Sat' ou 'Sun'
  return weekday === 'Sat' || weekday === 'Sun'
}

/**
 * Calcula a comissão da apresentadora de acordo com as regras de negócio:
 *   - Se não há apresentadora vinculada (`temApresentadora = false`), retorna null/null.
 *   - Se a live iniciou em fim de semana (America/Sao_Paulo), pct = 2 (override fixo).
 *   - Caso contrário, usa `apresentadoraPct` do cadastro.
 *   - Se `apresentadoraPct` é null E não é fim de semana → pct fica null (nenhum valor
 *     negociado), valor null.
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
 * Calcula a comissão LiveLab (empresa).
 *
 * O arredondamento a 2 casas decimais é INTENCIONAL ao banco (coluna NUMERIC 15,2):
 * o valor é inserido cru e o PostgreSQL faz o arredondamento. Manter Math.round
 * aqui divergia 1 centavo em edge-cases de ponto flutuante (ex: 2.675 → 2.68 JS vs
 * 2.67 Postgres). Retornamos o float puro para que o banco seja a fonte da verdade.
 *
 * ATENÇÃO: NÃO adicionar Math.round aqui sem avaliar paridade com legado.
 *
 * @param {{ fatGerado: number, contratoPct: number | null }} params
 * @returns {{ pct: number, valor: number }}
 */
export function calcularComissaoLivelab({ fatGerado, contratoPct }) {
  const pct = Number(contratoPct ?? 0)
  const valor = fatGerado * (pct / 100)
  return { pct, valor }
}

/**
 * FÓRMULA ÚNICA da comissão de franquia (decisão do produto, 2ª onda).
 *
 * comissao_franquia = MAX(valorFixo, gmv * pct / 100)
 *
 * Onde `pct` = marcas.comissao_franquia_pct e `valorFixo` = marcas.valor_fixo_minimo
 * (os campos editados no Comercial). Esta é a fonte ÚNICA usada tanto pelo
 * commission-engine (vendas_atribuidas, rateado por apresentadora) quanto por
 * lives.comissao_calculada (total), garantindo Financeiro == Comissões.
 *
 * Float puro (sem Math.round) — o Postgres (NUMERIC 15,2) é a fonte de arredondamento,
 * mesma convenção de calcularComissaoLivelab acima.
 *
 * @param {{ gmv: number, pct: number | null, valorFixo: number | null }} params
 * @returns {number}
 */
export function calcularComissaoFranquia({ gmv, pct, valorFixo }) {
  const g = Number(gmv ?? 0)
  const p = Number(pct ?? 0)
  const piso = Number(valorFixo ?? 0)
  return Math.max(piso, g * (p / 100))
}
