import { exactMoneyToCents } from '../lib/money.js'
import { buscarConfigFinanceiro, dataValida, hojeSaoPaulo } from './financeiro-agregador.js'
import { addMeses, ultimoDia } from './custos-plano.js'
import { lerMovimentosFinanceirosPeriodo } from './financeiro-movimentos-periodo.js'
import { buscarHistoricoObrigacoes, referenciaFinanceira, selecionarObrigacoesPorVencimento, valoresObrigacao } from './financeiro-obrigacoes-vencimento.js'

const decimal = (cents) => {
  if (cents === null) return null
  const absolute = cents < 0n ? -cents : cents
  return `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}
const cents = (value) => {
  try { return exactMoneyToCents(String(value)) } catch {
    throw Object.assign(new Error('Valor monetário ausente ou inválido na fonte financeira'), { statusCode: 422, code: 'INVALID_FINANCIAL_AMOUNT' })
  }
}
const nextDay = (day) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}
const signed = item => cents(item.valor) * (item.natureza === 'receita' ? 1n : -1n)

/**
 * Daily civil-date scenario. Opening precedes cutoff-day events. On the data
 * base, today's real events are displayed and counted once; subsequent facts
 * dated in the future are projected on their recorded day, never treated as cash
 * already available. Overdue payables are a reserve, not an invented payment.
 */
export function montarCaixaOperacional({ config, dataBase, obrigacoes = [], movimentos = [], reconciliacao = null, historico }) {
  if (!dataValida(dataBase)) throw Object.assign(new Error('Data-base inválida'), { statusCode: 400 })
  const fim = ultimoDia(addMeses(dataBase.slice(0, 7), 5))
  const configurado = Boolean(config?.data_corte && dataValida(config.data_corte)
    && config.data_corte <= dataBase && config.saldo_abertura != null)
  const corte = config?.data_corte && dataValida(config.data_corte) && config.data_corte <= dataBase ? config.data_corte : null
  const fatos = movimentos.filter(i => i.data && (!corte || i.data >= corte) && i.data <= fim)
    .map(i => ({ ...i, valor: decimal(cents(i.valor)) }))
  const realizados = fatos.filter(i => i.data <= dataBase)
  const futuros = fatos.filter(i => i.data > dataBase)
  const futurosPorOrigem = new Map()
  // This includes dated payments beyond the six-month display horizon: they
  // must not make an obligation look settled on the base date.
  for (const item of movimentos.filter(i => i.data > dataBase)) {
    const key = referenciaFinanceira(item)
    if (!futurosPorOrigem.has(key)) futurosPorOrigem.set(key, [])
    futurosPorOrigem.get(key).push(item)
  }
  const saldoAtual = configurado ? realizados.reduce((n, i) => n + signed(i), cents(config.saldo_abertura)) : null
  const hojeRealizado = realizados.filter(i => i.data === dataBase).reduce((n, i) => n + signed(i), 0n)
  const pendencias = { recebiveis_vencidos: [], pagaveis_vencidos: [], sem_data: [],
    comissao_futura: 'nao_estimada', comissoes_nao_estimadas: [], movimentos_futuros: futuros, historico: historico?.pendencias ?? [] }
  const porDia = new Map()
  const estados = new Map()
  const baixasProjetadas = new Map()
  const eventosPorDia = new Map()
  const day = date => {
    if (!porDia.has(date)) porDia.set(date, { entradas_realizadas: 0n, saidas_realizadas: 0n, entradas_projetadas: 0n, saidas_projetadas: 0n })
    return porDia.get(date)
  }
  const itens = obrigacoes.map((item) => {
    const acumulado = valoresObrigacao(item)
    const key = referenciaFinanceira(item)
    const eventosFuturos = futurosPorOrigem.get(key) ?? []
    const pagoNaData = acumulado.pago - eventosFuturos.reduce((n, e) => n + cents(e.valor), 0n)
    const { original, encerrado, aberto } = valoresObrigacao({ ...item, valor_pago: decimal(pagoNaData) })
    const result = { ...item, valor_original: decimal(original), valor_previsto: decimal(cents(item.valor_previsto)),
      valor_pago: decimal(acumulado.pago), liquidado_acumulado: decimal(acumulado.pago), liquidado_na_data: decimal(pagoNaData), valor_encerrado: decimal(encerrado),
      saldo_aberto: decimal(aberto), valor_projetado: '0.00', inconsistente: aberto < 0n || acumulado.aberto < 0n || pagoNaData < 0n }
    const data = item.data_vencimento
    const encerrada = Boolean(item.cancelado_em || item.suspensao_comercial?.ativa || (item.perdido_em && item.valor_perdido == null))
    const comissaoFutura = item.virtual && String(item.competencia).slice(0, 7) > dataBase.slice(0, 7)
      && (item.origem === 'marca_comissao' || (item.origem === 'apresentadora' && item.componente === 'variavel'))
    if (comissaoFutura) {
      if (aberto > 0n) { result.projecao = 'nao_estimada'; pendencias.comissoes_nao_estimadas.push(result) }
    } else if (!data || !dataValida(data)) {
      if (aberto > 0n) pendencias.sem_data.push(result)
    } else {
      // A later refund can reopen an obligation that is fully paid today.
      if (item.natureza === 'custo' && !encerrada) estados.set(key, { data, aberto })
      if (data < dataBase) {
        if (aberto > 0n) pendencias[item.natureza === 'receita' ? 'recebiveis_vencidos' : 'pagaveis_vencidos'].push(result)
      } else if (data <= fim && !encerrada) {
        // Dated facts have precedence over an assumed settlement at maturity.
        // Refunds before maturity reopen its residual; later refunds remain
        // dated cash events and may create an overdue reserve on their own day.
        const alocado = eventosFuturos.reduce((n, e) => n + (e.data <= data || cents(e.valor) > 0n ? cents(e.valor) : 0n), 0n)
        const projetado = aberto > alocado ? aberto - alocado : 0n
        result.valor_projetado = decimal(projetado)
        day(data)[item.natureza === 'receita' ? 'entradas_projetadas' : 'saidas_projetadas'] += projetado
        if (!baixasProjetadas.has(data)) baixasProjetadas.set(data, [])
        baixasProjetadas.get(data).push({ key, valor: projetado })
      }
    }
    return result
  })
  for (const item of fatos.filter(i => i.data >= dataBase)) {
    const efeito = signed(item)
    const category = `${efeito >= 0n ? 'entradas' : 'saidas'}_${item.data > dataBase ? 'projetadas' : 'realizadas'}`
    day(item.data)[category] += efeito < 0n ? -efeito : efeito
    if (item.data > dataBase) {
      if (!eventosPorDia.has(item.data)) eventosPorDia.set(item.data, [])
      eventosPorDia.get(item.data).push(item)
    }
  }
  const reservaEm = data => [...estados.values()].reduce((n, i) => n + (i.data < data && i.aberto > 0n ? i.aberto : 0n), 0n)
  const reservaAtual = reservaEm(dataBase)

  let saldo = saldoAtual === null ? null : saldoAtual - hojeRealizado
  const serie = []
  const months = new Map()
  let minimo = null, primeiroNegativo = null
  for (let data = dataBase; data <= fim; data = nextDay(data)) {
    const valores = day(data)
    for (const item of eventosPorDia.get(data) ?? []) {
      const estado = estados.get(referenciaFinanceira(item))
      if (estado) estado.aberto -= cents(item.valor)
    }
    for (const baixa of baixasProjetadas.get(data) ?? []) {
      const estado = estados.get(baixa.key)
      if (estado) estado.aberto -= baixa.valor
    }
    const reserva = reservaEm(data)
    const mes = data.slice(0, 7)
    if (!months.has(mes)) months.set(mes, { mes, saldo_inicial: decimal(saldo),
      entradas_realizadas: 0n, saidas_realizadas: 0n, entradas_projetadas: 0n, saidas_projetadas: 0n,
      reserva_vencida: decimal(reserva), menor_saldo_diario: null, primeiro_dia_negativo: null })
    const month = months.get(mes)
    month.reserva_vencida = decimal(reserva)
    const saldoInicial = saldo
    if (saldo !== null) saldo += valores.entradas_realizadas - valores.saidas_realizadas + valores.entradas_projetadas - valores.saidas_projetadas
    const disponivel = saldo === null ? null : saldo - reserva
    for (const key of Object.keys(valores)) month[key] += valores[key]
    if (disponivel !== null) {
      if (minimo === null || disponivel < minimo) minimo = disponivel
      if (month.menor_saldo_diario === null || disponivel < month.menor_saldo_diario) month.menor_saldo_diario = disponivel
      if (disponivel < 0n) { primeiroNegativo ??= data; month.primeiro_dia_negativo ??= data }
    }
    month.saldo_final_projetado = decimal(saldo)
    month.saldo_disponivel_final = decimal(disponivel)
    serie.push({ dia: data, saldo_inicial: decimal(saldoInicial),
      ...Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, decimal(v)])),
      reserva_vencida: decimal(reserva), saldo_final_projetado: decimal(saldo), saldo_disponivel_projetado: decimal(disponivel) })
  }
  return {
    data_base: dataBase, horizonte: { inicio: dataBase, fim, meses: 6 },
    caixa: { configurado, data_corte: config?.data_corte ?? null, saldo_abertura: configurado ? decimal(cents(config.saldo_abertura)) : null,
      saldo_atual: decimal(saldoAtual), reserva_pagaveis_vencidos: decimal(reservaAtual),
      saldo_disponivel: decimal(saldoAtual === null ? null : saldoAtual - reservaAtual), origem: 'registrado_no_sistema', escopo: 'agregado' },
    serie_diaria: serie,
    meses: [...months.values()].map(m => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'bigint' ? decimal(v) : v]))),
    indicadores: { menor_saldo_diario: decimal(minimo), primeiro_dia_negativo: primeiroNegativo },
    obrigacoes: itens, movimentos: realizados, pendencias, reconciliacao,
    completude: { saldo_configurado: configurado, obrigacoes_com_data: pendencias.sem_data.length === 0,
      obrigacoes_consistentes: !itens.some(i => i.inconsistente), comissoes_futuras_estimadas: false,
      historico_obrigacoes_completo: pendencias.historico.length === 0 && pendencias.sem_data.length === 0,
      repasses_pendentes_incluidos_no_saldo: false, escopo: 'obrigacoes_e_movimentos_registrados' },
  }
}

export async function calcularCaixaOperacional(db, { tenantId, hoje = hojeSaoPaulo() } = {}) {
  const config = await buscarConfigFinanceiro(db, tenantId, { dinheiroExato: true })
  const corte = dataValida(config.data_corte) && config.data_corte <= hoje ? config.data_corte : null
  const fim = ultimoDia(addMeses(hoje.slice(0, 7), 5))
  const historico = await buscarHistoricoObrigacoes(db, { tenantId, ate: fim })
  const obrigacoes = await selecionarObrigacoesPorVencimento(db, {
    tenantId, de: corte ?? hoje, ate: fim, hoje, config: { ...config, data_corte: corte }, incluirSemData: true, incluirVencidos: true,
    historico,
  })
  const movimentos = await lerMovimentosFinanceirosPeriodo(db, {
    tenantId, de: corte ?? hoje, ate: fim, dataCorte: corte, dinheiroExato: true, incluirFuturos: true,
  })
  return montarCaixaOperacional({ config, dataBase: hoje, obrigacoes, movimentos: movimentos.itens, reconciliacao: movimentos.reconciliacao, historico })
}
