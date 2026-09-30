// Lógica PURA de conciliação Asaas ↔ financeiro (sem I/O, sem banco, sem rede).
//
// Entradas:
//   - transação normalizada (ver normalizarTransacaoAsaas):
//       { id, tipo: 'entrada'|'saida', valor, valor_bruto?, data: 'YYYY-MM-DD', customer_id? }
//   - candidato (montado por candidatoDeLancamento a partir do contrato comum de receitas/custos):
//       { tipo: 'receita'|'custo', id, valores: number[], data_referencia: 'YYYY-MM-DD',
//         gateway_customer_id?, descricao? }
//     `valores` lista os montantes aceitáveis (ex.: total pendente, só o fixo,
//     só a comissão — a planilha cobra fixo e comissão separados).
//
// Datas trafegam como string 'YYYY-MM-DD' (convenção do projeto) — nunca Date,
// pra não sofrer com fuso.

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/
const RE_MES = /^\d{4}-\d{2}$/

// Pesos do score (máx. 100)
export const PESOS = Object.freeze({
  CUSTOMER: 50,          // mesmo customer Asaas do cliente do contrato
  CUSTOMER_DIVERGENTE: -40,
  VALOR_EXATO: 35,       // centavo a centavo
  VALOR_1PCT: 25,        // até 1% de diferença (taxa de boleto/pix embutida etc.)
  VALOR_5PCT: 10,
  MESMO_MES: 15,
  MES_VIZINHO: 5,        // ±1 mês (comissão de M é recebida em M+1, atrasos)
})

export const SCORE_MINIMO_PADRAO = 40

export function centavos(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

export function isData(s) {
  if (typeof s !== 'string' || !RE_DATA.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function isMes(s) {
  return typeof s === 'string' && RE_MES.test(s) && Number(s.slice(5, 7)) >= 1 && Number(s.slice(5, 7)) <= 12
}

// Índice absoluto do mês (ano*12 + mês-1) — facilita diferença entre meses.
function indiceMes(data) {
  return Number(data.slice(0, 4)) * 12 + Number(data.slice(5, 7)) - 1
}

export function diffMeses(a, b) {
  return Math.abs(indiceMes(a) - indiceMes(b))
}

// 'YYYY-MM' + dia → 'YYYY-MM-DD', limitando ao último dia do mês (dia 30 em fevereiro → 28/29).
export function dataNoMes(mesOuData, dia) {
  const y = Number(mesOuData.slice(0, 4))
  const m = Number(mesOuData.slice(5, 7))
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const d = Math.min(Math.max(Number(dia) || 1, 1), ultimo)
  return `${mesOuData.slice(0, 7)}-${String(d).padStart(2, '0')}`
}

// Soma dias a uma data 'YYYY-MM-DD' (UTC puro, sem fuso).
export function somarDias(data, dias) {
  const [y, m, d] = data.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + dias))
  return dt.toISOString().slice(0, 10)
}

// Resolve e valida o período ?inicio&fim (YYYY-MM-DD).
// Padrão: do 1º dia do mês anterior até `hoje`. Limite de `maxDias` para não
// estourar a paginação do Asaas numa única requisição.
export function resolverPeriodo({ inicio, fim } = {}, hoje, { maxDias = 366 } = {}) {
  if (!isData(hoje)) throw new Error('hoje inválido')
  let fimR = fim ?? hoje
  let inicioR = inicio
  if (inicioR == null) {
    const y = Number(hoje.slice(0, 4))
    const m = Number(hoje.slice(5, 7))
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1]
    inicioR = `${py}-${String(pm).padStart(2, '0')}-01`
  }
  if (!isData(inicioR) || !isData(fimR)) {
    return { erro: 'Datas devem estar no formato YYYY-MM-DD' }
  }
  if (inicioR > fimR) return { erro: 'inicio deve ser menor ou igual a fim' }
  const dias = (Date.parse(`${fimR}T00:00:00Z`) - Date.parse(`${inicioR}T00:00:00Z`)) / 86400000
  if (dias > maxDias) return { erro: `Período máximo de ${maxDias} dias` }
  return { inicio: inicioR, fim: fimR }
}

// Converte uma financialTransaction do Asaas (+ payment opcional) na linha de gateway_transacoes.
// SUPOSIÇÃO (validar com chave real): `value` vem com sinal — positivo = crédito
// na conta, negativo = débito (taxas, transferências). `date` = 'YYYY-MM-DD'.
export function normalizarTransacaoAsaas(ft, pagamento = null) {
  if (!ft || !ft.id) return null
  const valorNum = Number(ft.value)
  if (!Number.isFinite(valorNum)) return null
  const data = typeof ft.date === 'string' ? ft.date.slice(0, 10) : null
  if (!isData(data)) return null
  const valorBruto = pagamento && Number.isFinite(Number(pagamento.value)) ? Number(pagamento.value) : null
  return {
    asaas_id: String(ft.id),
    tipo: valorNum < 0 ? 'saida' : 'entrada',
    tipo_asaas: ft.type ?? null,
    valor: Math.abs(valorNum),
    valor_bruto: valorBruto,
    data,
    descricao: ft.description ?? pagamento?.description ?? null,
    payment_id: ft.paymentId ?? pagamento?.id ?? null,
    customer_id: pagamento?.customer ?? null,
    raw: { transacao: ft, pagamento: pagamento ?? null },
  }
}

// Tipo de alvo permitido para cada sentido da transação.
export function validarTipoConciliacao(tipoTransacao, tipoAlvo) {
  if (tipoAlvo === 'receita' && tipoTransacao !== 'entrada') {
    return 'Só entradas podem ser conciliadas com receitas'
  }
  if (tipoAlvo === 'custo' && tipoTransacao !== 'saida') {
    return 'Só saídas podem ser conciliadas com custos'
  }
  if (tipoAlvo !== 'receita' && tipoAlvo !== 'custo') return 'tipo deve ser receita ou custo'
  return null
}

function pontuarValor(transacao, valoresCandidato) {
  const alvos = [transacao.valor, transacao.valor_bruto]
    .map(centavos)
    .filter((c) => c != null && c > 0)
  let melhor = { pontos: 0, motivo: null }
  for (const vc of valoresCandidato ?? []) {
    const c = centavos(vc)
    if (c == null || c <= 0) continue
    for (const t of alvos) {
      const diff = Math.abs(t - c) / c
      let r = { pontos: 0, motivo: null }
      if (t === c) r = { pontos: PESOS.VALOR_EXATO, motivo: 'valor_exato' }
      else if (diff <= 0.01) r = { pontos: PESOS.VALOR_1PCT, motivo: 'valor_aprox_1pct' }
      else if (diff <= 0.05) r = { pontos: PESOS.VALOR_5PCT, motivo: 'valor_aprox_5pct' }
      if (r.pontos > melhor.pontos) melhor = { ...r, valor_casado: c / 100 }
    }
  }
  return melhor
}

// Score 0..100 + motivos legíveis pela UI.
export function pontuarMatch(transacao, candidato) {
  const motivos = []
  let score = 0

  const tc = transacao.customer_id
  const cc = candidato.gateway_customer_id
  if (tc && cc) {
    if (tc === cc) {
      score += PESOS.CUSTOMER
      motivos.push('mesmo_customer')
    } else {
      score += PESOS.CUSTOMER_DIVERGENTE
      motivos.push('customer_divergente')
    }
  }

  const v = pontuarValor(transacao, candidato.valores)
  let valorCasado = null
  if (v.pontos > 0) {
    score += v.pontos
    motivos.push(v.motivo)
    valorCasado = v.valor_casado
  }

  if (isData(transacao.data) && isData(candidato.data_referencia)) {
    const dm = diffMeses(transacao.data, candidato.data_referencia)
    if (dm === 0) {
      score += PESOS.MESMO_MES
      motivos.push('mesmo_mes')
    } else if (dm === 1) {
      score += PESOS.MES_VIZINHO
      motivos.push('mes_vizinho')
    }
  }

  return { score: Math.max(0, Math.min(100, score)), motivos, valor_casado: valorCasado }
}

// Para cada transação, devolve as melhores sugestões (ordenadas por score desc).
// Candidatos de tipo incompatível (receita x saída / custo x entrada) são ignorados.
// `ambiguo` = as duas melhores sugestões empatam — UI deve pedir confirmação manual.
export function sugerirMatches(transacoes, candidatos, { limite = 3, scoreMinimo = SCORE_MINIMO_PADRAO } = {}) {
  return (transacoes ?? []).map((t) => {
    const sugestoes = []
    for (const c of candidatos ?? []) {
      if (validarTipoConciliacao(t.tipo, c.tipo)) continue
      const { score, motivos, valor_casado } = pontuarMatch(t, c)
      if (score < scoreMinimo) continue
      sugestoes.push({
        tipo: c.tipo,
        id: c.id,
        descricao: c.descricao ?? null,
        data_referencia: c.data_referencia ?? null,
        valor_casado,
        score,
        motivos,
      })
    }
    // Desempate estável: score desc, depois data de referência mais próxima.
    sugestoes.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const da = a.data_referencia && isData(t.data) ? Math.abs(Date.parse(a.data_referencia) - Date.parse(t.data)) : Infinity
      const db = b.data_referencia && isData(t.data) ? Math.abs(Date.parse(b.data_referencia) - Date.parse(t.data)) : Infinity
      return da - db
    })
    const top = sugestoes.slice(0, limite)
    return {
      transacao_id: t.id,
      sugestoes: top,
      ambiguo: top.length >= 2 && top[0].score === top[1].score,
    }
  })
}

// Monta candidato a partir de um lançamento do contrato comum das frentes A/B
// (listarTitulosReceita / listarCustos): { id, natureza, descricao, data_vencimento,
// valor_previsto, valor_pago, cliente_id? }. O valor aceito é o saldo pendente
// (previsto − pago); títulos já quitados ou sem saldo não viram candidatos.
// `gatewayCustomerPorCliente` = Map(cliente_id → cus_* do Asaas).
export function candidatoDeLancamento(l, gatewayCustomerPorCliente = new Map()) {
  const natureza = l?.natureza === 'custo' ? 'custo' : 'receita'
  const pendente = Math.max(0, Number(l?.valor_previsto ?? 0) - Number(l?.valor_pago ?? 0))
  const c = centavos(pendente)
  if (!c || c <= 0) return null
  const venc = typeof l.data_vencimento === 'string' ? l.data_vencimento.slice(0, 10) : null
  const comp = typeof l.competencia === 'string' ? l.competencia.slice(0, 10) : null
  const ref = venc && isData(venc) ? venc : comp && isData(comp) ? comp : null
  return {
    tipo: natureza,
    id: l.id,
    valores: [c / 100],
    data_referencia: ref,
    gateway_customer_id: l.cliente_id ? gatewayCustomerPorCliente.get(l.cliente_id) ?? null : null,
    descricao: l.descricao ?? null,
  }
}

// PONTO DE EXTENSÃO (onda 2): dar baixa no título/custo quando a conciliação é
// confirmada. Nesta onda NÃO baixa nada — a rota só grava o vínculo.
// A onda 2 deve implementar aqui: receita → marcar valor_pago/data_pagamento do
// título (materializando-o se virtual); custo → idem; usando `transacao.valor` e
// `transacao.data`. Deve rodar dentro da mesma transação do vínculo.
export async function darBaixaConciliacao(_db, { tenantId: _t, transacao: _tx, tipo: _tipo, alvoId: _id, userId: _u } = {}) {
  return { aplicada: false, motivo: 'baixa_automatica_indisponivel_nesta_onda' }
}
