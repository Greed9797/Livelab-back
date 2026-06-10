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
 * @property {number|null} comissaoLivelabPct  - Comissão LiveLab percentual
 * @property {number|null} horas               - Horas de live realizadas
 * @property {number|null} gmv                 - GMV medido (null = não informado; 0 = medido zero)
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
  /** Taxa de conversão (pedidos/clicks) abaixo deste valor indica problema de checkout/confiança */
  conversaoMin: 0.05,
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
  if (input.clicks == null)      faltantes.push('cliques não informados')
  if (input.horas == null)       faltantes.push('horas não informadas')
  if (input.gmv == null)         faltantes.push('GMV não informado')

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
      diagnostico: 'Baixa visualização por hora — revisar entrega/tráfego',
      proxima_acao:
        'Ajustar horário da live, reforçar divulgação prévia ou revisar configurações de entrega no TikTok',
    }
  }

  // --- CTR (cliques / visualizações) ---
  const ctr = views != null && views > 0 && clicks != null
    ? clicks / views
    : null

  if (viewsPorHora != null && viewsPorHora >= thresholds.viewsPorHoraMin && ctr != null && ctr < thresholds.ctrMin) {
    return {
      diagnostico: 'Boa visualização, pouco clique — revisar oferta, produto, gancho ou CTA',
      proxima_acao:
        'Testar ganchos mais fortes nos primeiros 30 s, revisar apresentação do produto, oferta ou CTA de clique',
    }
  }

  // --- Conversão (pedidos / cliques) ---
  const conversao = clicks != null && clicks > 0 && pedidos != null
    ? pedidos / clicks
    : null

  if (ctr != null && ctr >= thresholds.ctrMin && conversao != null && conversao < thresholds.conversaoMin) {
    return {
      diagnostico: 'Bons cliques, poucos pedidos — revisar preço, frete, cupom, checkout ou confiança',
      proxima_acao:
        'Verificar se o carrinho/checkout está funcional, testar cupom de urgência, revisar política de frete e avaliações do produto',
    }
  }

  // --- Ticket médio (GMV / pedidos) ---
  const ticket = pedidos != null && pedidos > 0 && gmv != null
    ? gmv / pedidos
    : null

  if (conversao != null && conversao >= thresholds.conversaoMin && ticket != null && ticket < thresholds.ticketMin) {
    return {
      diagnostico: 'Pedidos bons, GMV baixo — revisar ticket médio ou mix de produtos',
      proxima_acao:
        'Priorizar produtos de maior valor, criar combos, destacar kits ou sugerir upsell durante a live',
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
      proxima_acao: 'Preencher os dados faltantes para habilitar o diagnóstico completo',
    }
  }

  // A partir daqui todos os campos obrigatórios estão presentes.
  const gmvPorHora = input.horas > 0 ? input.gmv / input.horas : 0

  // 3. ATENÇÃO ou OK — calcular diagnóstico em ambos os casos
  const { diagnostico, proxima_acao } = _diagnosticarFunil(input, t)

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
