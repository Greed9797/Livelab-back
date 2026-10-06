import { exactMoneyToCents } from '../lib/money.js'
import { filtrarLancamentos, hojeSaoPaulo, listarLancamentos, valorEncerrado } from './financeiro-agregador.js'

const ORIGENS = ['marca_fixo', 'marca_comissao', 'avulsa', 'manual', 'recorrente', 'parcela', 'apresentadora', 'imposto']
const STATUS = ['previsto', 'pendente', 'atrasado', 'parcial', 'pago', 'perdido', 'cancelado']
const EIXOS = ['competencia', 'vencimento', 'pagamento']
const ORDENACOES = ['data', 'valor']
const MONEY_RE = /^\d{1,13}(?:\.\d{1,2})?$/

function invalid(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function monthIndex(month) {
  const [year, number] = month.split('-').map(Number)
  return year * 12 + number
}

function dateText(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
  const text = String(value ?? '')
  return /^\d{4}-\d{2}-\d{2}(?:$|T| )/.test(text) ? text.slice(0, 10) : null
}

function cents(value) {
  // Ausência de valor não equivale a zero; falhar a leitura evita total enganoso.
  if (value === null || value === undefined || value === '') {
    const error = new Error('Valor financeiro ausente no lançamento')
    error.statusCode = 422
    throw error
  }
  return exactMoneyToCents(String(value))
}

function decimal(value) {
  const abs = value < 0n ? -value : value
  return `${value < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`
}

function integer(value, name, fallback, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > max || !Number.isSafeInteger(Number(value))) {
    throw invalid(`${name} deve ser inteiro entre 1 e ${max}`)
  }
  return Number(value)
}

/**
 * Query pública de GET /v1/financeiro/consulta e /consulta.csv:
 * eixo=competencia|vencimento|pagamento, inicio/fim=AAAA-MM (inclusive),
 * competencia_inicio/competencia_fim=AAAA-MM (obrigatórios nos eixos vencimento/pagamento;
 * delimitam as competências carregadas pelo agregador), natureza=receita|custo,
 * origem, componente, contraparte (texto), status, q (texto),
 * valor_min/valor_max (valor_previsto decimal positivo),
 * ordenar=data|valor, direcao=asc|desc, pagina (1..1000000), limite (1..200).
 * O CSV aceita os mesmos parâmetros, mas ignora pagina/limite. Ambos os intervalos
 * são limitados a 36 meses para impedir leitura ilimitada em memória.
 */
export function parseConsultaQuery(query = {}) {
  const allowed = new Set(['eixo', 'inicio', 'fim', 'competencia_inicio', 'competencia_fim', 'natureza', 'origem', 'componente', 'contraparte', 'status', 'q', 'valor_min', 'valor_max', 'ordenar', 'direcao', 'pagina', 'limite'])
  for (const key of Object.keys(query)) if (!allowed.has(key)) throw invalid(`Filtro desconhecido: ${key}`)
  for (const [key, value] of Object.entries(query)) if (typeof value !== 'string') throw invalid(`${key} deve ser único`)
  const { eixo, inicio, fim } = query
  if (!EIXOS.includes(eixo)) throw invalid('eixo deve ser competencia, vencimento ou pagamento')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(inicio ?? '') || !/^\d{4}-(0[1-9]|1[0-2])$/.test(fim ?? '') || inicio > fim) throw invalid('inicio/fim devem ser meses válidos em ordem AAAA-MM')
  if (monthIndex(fim) - monthIndex(inicio) >= 36) throw invalid('Período máximo de 36 meses')

  let competencia_inicio = query.competencia_inicio
  let competencia_fim = query.competencia_fim
  if (eixo === 'competencia') {
    if (competencia_inicio !== undefined || competencia_fim !== undefined) throw invalid('competencia_inicio/fim só se aplicam a vencimento/pagamento')
    competencia_inicio = inicio
    competencia_fim = fim
  } else {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia_inicio ?? '') || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia_fim ?? '')) {
      throw invalid('competencia_inicio/fim são obrigatórios no formato AAAA-MM')
    }
  }
  if (competencia_inicio > competencia_fim || monthIndex(competencia_fim) - monthIndex(competencia_inicio) >= 36) {
    throw invalid('Competências devem estar em ordem e cobrir no máximo 36 meses')
  }
  if (query.natureza !== undefined && !['receita', 'custo'].includes(query.natureza)) throw invalid('natureza inválida')
  if (query.origem !== undefined && !ORIGENS.includes(query.origem)) throw invalid('origem inválida')
  if (query.status !== undefined && !STATUS.includes(query.status)) throw invalid('status inválido')
  if (query.componente !== undefined && (query.componente.trim().length < 1 || query.componente.length > 80)) throw invalid('componente deve ter entre 1 e 80 caracteres')
  if (query.contraparte !== undefined && (query.contraparte.trim().length < 1 || query.contraparte.length > 120)) throw invalid('contraparte deve ter entre 1 e 120 caracteres')
  if (query.q !== undefined && (query.q.trim().length < 1 || query.q.length > 120)) throw invalid('q deve ter entre 1 e 120 caracteres')
  if (query.ordenar !== undefined && !ORDENACOES.includes(query.ordenar)) throw invalid('ordenar inválido')
  if (query.direcao !== undefined && !['asc', 'desc'].includes(query.direcao)) throw invalid('direcao inválida')
  for (const name of ['valor_min', 'valor_max']) {
    if (query[name] !== undefined && !MONEY_RE.test(query[name])) throw invalid(`${name} deve ser decimal positivo com até duas casas`)
  }
  if (query.valor_min !== undefined && query.valor_max !== undefined && cents(query.valor_min) > cents(query.valor_max)) throw invalid('valor_min deve ser menor ou igual a valor_max')
  const pagina = integer(query.pagina, 'pagina', 1, 1_000_000)
  const limite = integer(query.limite, 'limite', 50, 200)
  return {
    filtros: {
      eixo, inicio, fim, competencia_inicio, competencia_fim,
      natureza: query.natureza ?? null, origem: query.origem ?? null, status: query.status ?? null,
      q: query.q?.trim() ?? null, componente: query.componente?.trim() ?? null,
      contraparte: query.contraparte?.trim() ?? null,
      valor_min: query.valor_min ?? null, valor_max: query.valor_max ?? null,
      ordenar: query.ordenar ?? 'data', direcao: query.direcao ?? 'asc',
    },
    pagina, limite,
  }
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
}

/** Seleção única para JSON e CSV: filtrar, ordenar e totalizar antes da paginação. */
export async function selecionarConsulta(db, { tenantId, filtros, hoje = hojeSaoPaulo() }) {
  const itensBase = await listarLancamentos(db, {
    tenantId, inicio: filtros.competencia_inicio, fim: filtros.competencia_fim, hoje,
  })
  const campoData = { competencia: 'competencia', vencimento: 'data_vencimento', pagamento: 'data_pagamento' }[filtros.eixo]
  const min = filtros.valor_min === null ? null : cents(filtros.valor_min)
  const max = filtros.valor_max === null ? null : cents(filtros.valor_max)
  const contraparte = filtros.contraparte ? normalizeText(filtros.contraparte) : null
  const componente = filtros.componente ? normalizeText(filtros.componente) : null
  const itens = filtrarLancamentos(itensBase, filtros).filter((item) => {
    if (componente && normalizeText(item.componente) !== componente) return false
    if (contraparte && !normalizeText([
      item.cliente_nome, item.marca_nome, item.apresentadora_nome,
      item.fornecedor_nome,
    ].filter(Boolean).join(' ')).includes(contraparte)) return false
    const data = dateText(item[campoData])
    if (!data || data.slice(0, 7) < filtros.inicio || data.slice(0, 7) > filtros.fim) return false
    const valor = cents(item.valor_previsto)
    return (min === null || valor >= min) && (max === null || valor <= max)
  })
  const byValue = filtros.ordenar === 'valor'
  const direction = filtros.direcao === 'desc' ? -1 : 1
  itens.sort((a, b) => {
    const first = byValue
      ? (cents(a.valor_previsto) < cents(b.valor_previsto) ? -1 : cents(a.valor_previsto) > cents(b.valor_previsto) ? 1 : 0)
      : compareText(dateText(a[campoData]), dateText(b[campoData]))
    return direction * first || compareText(String(a.origem ?? ''), String(b.origem ?? ''))
      || compareText(String(a.id ?? ''), String(b.id ?? ''))
      || compareText(String(a.componente ?? ''), String(b.componente ?? ''))
  })
  const totaisCentavos = { previsto: 0n, pago: 0n, aberto: 0n }
  const itensComSaldo = itens.map((item) => {
    const previsto = cents(item.valor_previsto)
    const pago = cents(item.valor_pago)
    const encerrado = cents(valorEncerrado(item))
    // Saldo negativo é uma divergência de origem; zerá-lo mascararia sobrepagamento.
    const aberto = previsto - pago - encerrado
    totaisCentavos.previsto += previsto
    totaisCentavos.pago += pago
    totaisCentavos.aberto += aberto
    return {
      ...item,
      // Esta API nova entrega dinheiro em texto decimal para o painel e CSV.
      // A representação JSON numérica perderia a garantia de centavos exatos.
      valor_previsto: decimal(previsto),
      valor_pago: decimal(pago),
      saldo_aberto: decimal(aberto),
      inconsistente: aberto < 0n,
    }
  })
  return { itens: itensComSaldo, total_registros: itensComSaldo.length, totais: Object.fromEntries(Object.entries(totaisCentavos).map(([key, value]) => [key, decimal(value)])), filtros }
}

export function paginarConsulta(selecao, { pagina, limite }) {
  return {
    ...selecao,
    itens: selecao.itens.slice((pagina - 1) * limite, pagina * limite),
    pagina, limite, total_paginas: Math.ceil(selecao.total_registros / limite),
  }
}

const CSV_COLUMNS = ['id', 'natureza', 'origem', 'status', 'competencia', 'data_vencimento', 'data_pagamento', 'descricao', 'grupo', 'componente', 'marca_nome', 'cliente_nome', 'observacao', 'valor_previsto', 'valor_pago', 'saldo_aberto']

function csvCell(value, kind) {
  let text = kind === 'money' ? decimal(cents(value)) : kind === 'date' ? (dateText(value) ?? '') : String(value ?? '')
  // Tab, CR, LF e espaços podem preceder um operador reconhecido por planilhas.
  if (kind === 'text' && /^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

/** CSV UTF-8, separador ;, datas ISO AAAA-MM-DD e decimal com ponto. */
export function consultaCsv(selecao) {
  const rows = [CSV_COLUMNS.join(';')]
  for (const item of selecao.itens) {
    rows.push(CSV_COLUMNS.map((key) => csvCell(item[key], key.startsWith('valor_') || key === 'saldo_aberto' ? 'money' : ['competencia', 'data_vencimento', 'data_pagamento'].includes(key) ? 'date' : 'text')).join(';'))
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`
}
