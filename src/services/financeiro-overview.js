import { exactMoneyToCents } from '../lib/money.js'
import { selecionarConsulta } from './financeiro-consulta.js'

const MONTH = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/
const DATE = /^(?!0000)\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/

const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 })

function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function parseOverviewQuery(query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (!['mes', 'data_referencia', 'pagina', 'limite'].includes(key)) throw invalid(`Filtro desconhecido: ${key}`)
    if (typeof value !== 'string') throw invalid(`${key} deve ser único`)
  }
  if (!MONTH.test(query.mes ?? '')) throw invalid('mes deve ser AAAA-MM válido')
  if (!validDate(query.data_referencia)) throw invalid('data_referencia deve ser uma data válida AAAA-MM-DD')
  const integer = (name, fallback, maximum) => {
    if (query[name] === undefined) return fallback
    if (!/^[1-9]\d*$/.test(query[name]) || !Number.isSafeInteger(Number(query[name])) || Number(query[name]) > maximum) {
      throw invalid(`${name} deve ser inteiro entre 1 e ${maximum}`)
    }
    return Number(query[name])
  }
  return { mes: query.mes, data_referencia: query.data_referencia, pagina: integer('pagina', 1, 1_000_000), limite: integer('limite', 50, 200) }
}

function identity(item) {
  if (item.id == null || item.origem == null || !['receita', 'custo'].includes(item.natureza)) return null
  return JSON.stringify([item.natureza, item.origem, item.id, item.componente ?? null])
}

function amount(value) {
  // FIN-04 supplies the read representation. Missing money is uncertainty, not zero.
  return value == null ? null : exactMoneyToCents(String(value))
}

function emptyTotals() {
  return { quantidade: 0, previsto: 0n, pago: 0n, aberto: 0n }
}

function decimal(cents) {
  const positive = cents < 0n ? -cents : cents
  return `${cents < 0n ? '-' : ''}${positive / 100n}.${String(positive % 100n).padStart(2, '0')}`
}

function publicTotals(value) {
  return {
    quantidade: value.quantidade,
    previsto: decimal(value.previsto),
    pago: decimal(value.pago),
    aberto: decimal(value.aberto),
  }
}

/** One FIN-04 read, in the route's tenant-scoped repeatable-read snapshot. */
export async function selecionarOverview(db, { tenantId, mes, data_referencia }) {
  const selection = await selecionarConsulta(db, {
    tenantId, hoje: data_referencia,
    filtros: {
      eixo: 'competencia', inicio: mes, fim: mes, competencia_inicio: mes, competencia_fim: mes,
      natureza: null, origem: null, status: null, q: null, valor_min: null, valor_max: null,
      ordenar: 'data', direcao: 'asc',
    },
  })
  const counts = new Map()
  for (const item of selection.itens) {
    const key = identity(item)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const receber = emptyTotals()
  const pagar = emptyTotals()
  const exceptions = []
  let incompletos = 0
  for (const item of selection.itens) {
    const key = identity(item)
    let motivo = null
    if (!key) motivo = 'identidade_ausente'
    else if (counts.get(key) > 1) motivo = 'identidade_duplicada'
    else if (item.inconsistente) motivo = 'saldo_inconsistente'
    else if (item.em_apuracao) motivo = 'em_apuracao'
    else if (item.virtual) motivo = 'nao_materializado'

    let previsto, pago, aberto
    try {
      previsto = amount(item.valor_previsto)
      pago = amount(item.valor_pago)
      aberto = amount(item.saldo_aberto)
    } catch (error) {
      // An invalid read value needs review; never turn it into a monetary zero.
      motivo ??= 'valor_invalido'
    }
    if (previsto === null || pago === null || aberto === null) motivo ??= 'valor_ausente'

    if (motivo) {
      incompletos++
      exceptions.push({ tipo: 'revisao_dados', motivo, natureza: item.natureza ?? null, origem: item.origem ?? null,
        id: item.id ?? null, componente: item.componente ?? null, data_vencimento: item.data_vencimento ?? null,
        saldo_aberto: aberto === undefined || aberto === null ? null : decimal(aberto) })
      continue
    }

    const total = item.natureza === 'receita' ? receber : pagar
    total.quantidade++
    total.previsto += previsto
    total.pago += pago
    total.aberto += aberto

    // Atraso só para obrigação identificável, materializada, não encerrada,
    // com vencimento contratual válido e saldo positivo. Em dúvida, omitir.
    const due = item.data_vencimento instanceof Date ? item.data_vencimento.toISOString().slice(0, 10) : item.data_vencimento
    if (aberto > 0n && ['previsto', 'pendente', 'atrasado', 'parcial'].includes(item.status) &&
        !item.perdido_em && !item.cancelado_em && validDate(due) && due < data_referencia) {
      exceptions.push({ tipo: 'vencido', motivo: null, natureza: item.natureza, origem: item.origem,
        id: item.id, componente: item.componente ?? null, data_vencimento: due,
        saldo_aberto: decimal(aberto) })
    }
  }
  exceptions.sort((a, b) =>
    (a.tipo === 'revisao_dados' ? 0 : 1) - (b.tipo === 'revisao_dados' ? 0 : 1) ||
    String(a.data_vencimento ?? '').localeCompare(String(b.data_vencimento ?? '')) ||
    String(a.natureza ?? '').localeCompare(String(b.natureza ?? '')) ||
    String(a.origem ?? '').localeCompare(String(b.origem ?? '')) ||
    String(a.id ?? '').localeCompare(String(b.id ?? '')) ||
    String(a.componente ?? '').localeCompare(String(b.componente ?? '')))

  return {
    mes, data_referencia,
    fonte: 'consulta_fin04',
    estado: incompletos ? 'incompleto' : selection.itens.length === 0 ? 'vazio' : 'apurado',
    incompletos,
    // These are only the eligible subset when incomplete; never label a partial sum as a full balance.
    totais: incompletos || selection.itens.length === 0 ? null : { receber: publicTotals(receber), pagar: publicTotals(pagar) },
    exceptions,
  }
}

export function paginarExceptions(selection, { pagina, limite }) {
  return {
    mes: selection.mes, data_referencia: selection.data_referencia, estado: selection.estado,
    itens: selection.exceptions.slice((pagina - 1) * limite, pagina * limite),
    total_registros: selection.exceptions.length, pagina, limite,
    total_paginas: Math.ceil(selection.exceptions.length / limite),
  }
}
