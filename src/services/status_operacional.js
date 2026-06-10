/**
 * Motor de status operacional para lives / períodos de venda.
 *
 * Regras de precedência (maior para menor):
 *   1. CRÍTICO  — gmv medido = 0 com horas >= limiar OU problema reportado
 *   2. DADOS INCOMPLETOS — campos obrigatórios ausentes (null)
 *   3. ATENÇÃO  — dados completos, gmv/h abaixo da meta, mas gmv > 0
 *   4. OK       — dados completos, gmv/h >= meta
 *
 * Todas as funções são puras: sem efeitos colaterais, sem I/O, sem mutação.
 */

/** @typedef {'critico'|'dados_incompletos'|'atencao'|'ok'} StatusOperacional */

/**
 * @typedef {Object} EntradaStatusOperacional
 * @property {number|null} metaGmvHora         - Meta de GMV por hora configurada
 * @property {number|null} margemPct           - Margem percentual configurada
 * @property {number|null} comissaoLivelabPct  - Comissão LiveLab configurada
 * @property {number|null} horas               - Horas de live (null = não medido; 0 = medido zero)
 * @property {number|null} gmv                 - GMV total (null = não medido; 0 = medido zero)
 * @property {number|null} pedidos             - Número de pedidos
 * @property {number|null} views               - Visualizações totais
 * @property {number|null} clicks              - Cliques totais
 * @property {string|null} problemaReportado   - Problema operacional reportado (livre)
 */

/**
 * @typedef {Object} ResultadoStatusOperacional
 * @property {StatusOperacional} status
 * @property {string[]}         motivos        - Razões legíveis pt-BR do status
 * @property {string|null}      diagnostico    - Causa provável (análise do funil)
 * @property {string|null}      proxima_acao   - Ação recomendada pt-BR
 */

/**
 * Thresholds padrão usados quando o caller não fornece overrides.
 */
export const DEFAULT_THRESHOLDS = {
  /** Horas mínimas de live para considerar gmv=0 como crítico */
  horasMinCritico: 1,
  /** Views por hora abaixo deste valor indicam problema de tráfego */
  viewsPorHoraMin: 500,
  /** CTR (clicks/views) abaixo deste valor indica problema de oferta/gancho */
  ctrMin: 0.02,
  /** Taxa de conversão (pedidos/clicks) abaixo deste valor indica problema de mix/preço */
  convMin: 0.01,
  /** Ticket médio (gmv/pedidos) abaixo deste valor indica problema de mix/preço */
  ticketMin: 50,
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Verifica condições críticas.
 * Retorna lista de motivos críticos (vazia = não crítico).
 *
 * @param {EntradaStatusOperacional} input
 * @param {typeof DEFAULT_THRESHOLDS} thresholds
 * @returns {string[]}
 */
function _checarCritico(input, thresholds) {
  const motivos = []

  if (input.problemaReportado != null && String(input.problemaReportado).trim() !== '') {
    motivos.push(`Problema reportado: ${String(input.problemaReportado).trim()}`)
  }

  if (
    input.horas != null &&
    input.horas >= thresholds.horasMinCritico &&
    input.gmv != null &&
    input.gmv === 0
  ) {
    motivos.push(
      `GMV zero após ${input.horas}h de live — nenhuma venda registrada no período`
    )
  }

  return motivos
}

/**
 * Lista campos obrigatórios faltantes.
 * Retorna array com descrição pt-BR de cada campo ausente (vazio = nenhum faltante).
 *
 * @param {EntradaStatusOperacional} input
 * @returns {string[]}
 */
function _camposFaltantes(input) {
  const faltantes = []

  if (input.metaGmvHora == null) faltantes.push('meta de GMV/hora não configurada')
  if (input.margemPct == null)   faltantes.push('margem não configurada')
  if (input.comissaoLivelabPct == null) faltantes.push('comissão LiveLab não configurada')
  if (input.horas == null)       faltantes.push('horas de live não medidas')
  if (input.gmv == null)         faltantes.push('GMV não medido')
  if (input.pedidos == null)     faltantes.push('pedidos não medidos')
  if (input.views == null)       faltantes.push('visualizações não medidas')
  if (input.clicks == null)      faltantes.push('cliques não medidos')

  return faltantes
}

/**
 * Analisa o funil e retorna { diagnostico, proxima_acao }.
 * Retorna null em ambos se não houver dados suficientes ou funil saudável.
 *
 * @param {EntradaStatusOperacional} input
 * @param {typeof DEFAULT_THRESHOLDS} thresholds
 * @returns {{ diagnostico: string|null, proxima_acao: string|null }}
 */
function _diagnosticarFunil(input, thresholds) {
  const { views, clicks, pedidos, gmv, horas } = input

  // --- Visualizações por hora ---
  const viewsPorHora = horas != null && horas > 0 && views != null
    ? views / horas
    : null

  if (viewsPorHora != null && viewsPorHora < thresholds.viewsPorHoraMin) {
    return {
      diagnostico: `Tráfego baixo: ${Math.round(viewsPorHora)} views/hora (mín. ${thresholds.viewsPorHoraMin})`,
      proxima_acao: 'Revisar estratégia de divulgação e horário da live; considerar impulsionamento',
    }
  }

  // --- CTR ---
  const ctr = views != null && views > 0 && clicks != null
    ? clicks / views
    : null

  if (ctr != null && ctr < thresholds.ctrMin) {
    return {
      diagnostico: `CTR baixo: ${(ctr * 100).toFixed(1)}% (mín. ${(thresholds.ctrMin * 100).toFixed(0)}%)`,
      proxima_acao: 'Revisar apresentação de produtos: thumbnails, gancho inicial e CTA durante a live',
    }
  }

  // --- Taxa de conversão ---
  const conv = clicks != null && clicks > 0 && pedidos != null
    ? pedidos / clicks
    : null

  if (conv != null && conv < thresholds.convMin) {
    return {
      diagnostico: `Conversão baixa: ${(conv * 100).toFixed(1)}% (mín. ${(thresholds.convMin * 100).toFixed(0)}%)`,
      proxima_acao: 'Checar mix de produtos, preço e urgência; usar cupons ou oferta relâmpago',
    }
  }

  // --- Ticket médio ---
  const ticket = pedidos != null && pedidos > 0 && gmv != null
    ? gmv / pedidos
    : null

  if (ticket != null && ticket < thresholds.ticketMin) {
    return {
      diagnostico: `Ticket médio baixo: R$${ticket.toFixed(2)} (mín. R$${thresholds.ticketMin})`,
      proxima_acao: 'Aumentar penetração de produtos de maior valor; sugerir upsell durante a live',
    }
  }

  return { diagnostico: null, proxima_acao: null }
}

// ---------------------------------------------------------------------------
// Função principal exportada
// ---------------------------------------------------------------------------

/**
 * Calcula o status operacional de uma live ou período de vendas.
 *
 * @param {EntradaStatusOperacional} input
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 * @returns {ResultadoStatusOperacional}
 */
export function calcularStatusOperacional(input, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds }

  // 1. CRÍTICO — vence tudo
  const motivosCriticos = _checarCritico(input, t)
  if (motivosCriticos.length > 0) {
    const { diagnostico, proxima_acao } = _diagnosticarFunil(input, t)
    return {
      status: 'critico',
      motivos: motivosCriticos,
      diagnostico,
      proxima_acao,
    }
  }

  // 2. DADOS INCOMPLETOS
  const faltantes = _camposFaltantes(input)
  if (faltantes.length > 0) {
    return {
      status: 'dados_incompletos',
      motivos: faltantes,
      diagnostico: null,
      proxima_acao: null,
    }
  }

  const { diagnostico, proxima_acao } = _diagnosticarFunil(input, t)

  // 3. ATENÇÃO vs OK — comparar gmv/hora com a meta
  const gmvPorHora = input.horas > 0 ? input.gmv / input.horas : 0

  if (gmvPorHora < input.metaGmvHora) {
    return {
      status: 'atencao',
      motivos: [
        `GMV/hora R$${gmvPorHora.toFixed(2)} abaixo da meta de R$${input.metaGmvHora.toFixed(2)}/hora`,
      ],
      diagnostico,
      proxima_acao,
    }
  }

  // 4. OK
  return {
    status: 'ok',
    motivos: [
      `GMV/hora R$${gmvPorHora.toFixed(2)} atingiu a meta de R$${input.metaGmvHora.toFixed(2)}/hora`,
    ],
    diagnostico,
    proxima_acao,
  }
}
