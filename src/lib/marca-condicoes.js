import { saoPauloDateInput } from './timezone.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const MAX_TEXT = 255

export const MARCA_CONDICAO_TIPOS_COBRANCA = Object.freeze([
  'fixo_mais_comissao',
  'fixo_ou_comissao',
])

function invalid(message) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'INVALID_MARCA_CONDITION'
  return error
}

/** Converte reais para centavos sem usar ponto flutuante na soma final. */
export function reaisParaCentavos(value, field = 'valor') {
  if (value === null || value === undefined || value === '') return 0
  const text = String(value).trim().replace(/^R\$\s*/i, '').replace(',', '.')
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw invalid(`${field} deve ter no máximo duas casas decimais`)
  const cents = Math.round(Number(text) * 100)
  if (!Number.isSafeInteger(cents) || cents < 0) throw invalid(`${field} deve ser um valor positivo`)
  return cents
}

export function centavosParaReais(value) {
  if (!Number.isSafeInteger(value)) throw invalid('centavos inválidos')
  return Number((value / 100).toFixed(2))
}

function percentToBasis(value, field) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number < 0 || number > 100) throw invalid(`${field} deve estar entre 0 e 100`)
  return Math.round(number * 100)
}

function monthStart(value) {
  if (typeof value !== 'string' || !MONTH_RE.test(value)) throw invalid('inicio_vigencia deve estar no formato AAAA-MM')
  return `${value}-01`
}

function dateOnly(value) {
  const date = typeof value === 'string' && DATE_RE.test(value) ? value : saoPauloDateInput(value)
  if (!date || !DATE_RE.test(date)) throw invalid('data do fato gerador inválida')
  const parsed = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw invalid('data do fato gerador inválida')
  return date
}

/** Normaliza o payload da condição sem inferir valores históricos. */
export function normalizarMarcaCondicao(input = {}) {
  const inicio = input.inicio_vigencia ?? input.competencia
  const inicioVigencia = typeof inicio === 'string' && MONTH_RE.test(inicio)
    ? monthStart(inicio)
    : typeof inicio === 'string' && DATE_RE.test(inicio) && inicio.endsWith('-01')
      ? inicio
      : (() => { throw invalid('inicio_vigencia deve ser o primeiro dia de um mês') })()
  const tipo = input.tipo_cobranca ?? 'fixo_mais_comissao'
  if (!MARCA_CONDICAO_TIPOS_COBRANCA.includes(tipo)) throw invalid('tipo_cobranca inválido')
  const motivo = input.motivo == null ? null : String(input.motivo).trim()
  if (motivo && motivo.length > MAX_TEXT) throw invalid('motivo excede o limite permitido')
  return {
    inicio_vigencia: inicioVigencia,
    fixo_mensal_cents: reaisParaCentavos(input.fixo_mensal ?? input.valor_fixo_minimo, 'fixo_mensal'),
    comissao_franquia_basis: percentToBasis(input.comissao_franquia_pct, 'comissao_franquia_pct'),
    comissao_franqueadora_basis: percentToBasis(input.comissao_franqueadora_pct, 'comissao_franqueadora_pct'),
    tipo_cobranca: tipo,
    fixo_confirmado: Boolean(input.fixo_confirmado),
    comissao_confirmada: Boolean(input.comissao_confirmada),
    origem: input.origem ?? 'gestao',
    motivo,
  }
}

/** Última condição ativa no mês da data, em horário civil de São Paulo. */
export function resolveMarcaCondicao(conditions = [], factDate) {
  const date = dateOnly(factDate)
  return conditions
    .filter((condition) => condition?.cancelled_at == null)
    .filter((condition) => String(condition.inicio_vigencia).slice(0, 10) <= date)
    .sort((a, b) => String(b.inicio_vigencia).localeCompare(String(a.inicio_vigencia)))[0] ?? null
}

export const resolveConditionAt = resolveMarcaCondicao
export const findMarcaCondicao = resolveMarcaCondicao

function pctCents(gmvCents, basisPoints) {
  // basis = percentage * 100; gmv cents × (basis / 10000) = commission cents.
  return Math.round(gmvCents * basisPoints / 10000)
}

/** Calcula uma competência isolada; valores de retorno são reais e centavos. */
export function calcularCobrancaCondicao({ condition, condicao, gmv = 0, gmvCents } = {}) {
  const current = condition ?? condicao
  if (!current) return { fixo: 0, comissao: 0, total: 0, fixoCents: 0, comissaoCents: 0, totalCents: 0 }
  const normalized = current.fixo_mensal_cents == null
    ? normalizarMarcaCondicao(current)
    : current
  const grossCents = gmvCents == null ? reaisParaCentavos(gmv, 'gmv') : reaisParaCentavos(centavosParaReais(gmvCents), 'gmv')
  const fixoCents = normalized.fixo_mensal_cents ?? reaisParaCentavos(current.fixo_mensal)
  const comissaoCents = pctCents(grossCents, normalized.comissao_franquia_basis ?? percentToBasis(current.comissao_franquia_pct, 'comissao_franquia_pct'))
  const totalCents = normalized.tipo_cobranca === 'fixo_ou_comissao'
    ? Math.max(fixoCents, comissaoCents)
    : fixoCents + comissaoCents
  return {
    fixo: centavosParaReais(fixoCents),
    comissao: centavosParaReais(comissaoCents),
    total: centavosParaReais(totalCents),
    fixoCents,
    comissaoCents,
    totalCents,
  }
}

export const calculateConditionCharge = calcularCobrancaCondicao

/** Soma competências já resolvidas em centavos; nunca aplica MAX ao intervalo. */
export function somarCobrancasCondicao(items = []) {
  const cents = items.reduce((total, item) => total + (item.totalCents ?? reaisParaCentavos(item.total ?? 0)), 0)
  return { total: centavosParaReais(cents), totalCents: cents }
}

/**
 * Gera um JOIN LATERAL parametrizado para consultas agregadas. `dateSql` deve
 * ser a data civil do fato gerador, e não a data em que o relatório foi rodado.
 */
export function marcaCondicaoAtSql({
  alias = 'mc',
  tenantSql = '$1',
  marcaSql = 'm.id',
  dateSql = 'l.iniciado_em AT TIME ZONE \'America/Sao_Paulo\'',
} = {}) {
  return `LEFT JOIN LATERAL (
    SELECT ${alias}.*
      FROM marca_condicoes_comerciais ${alias}
     WHERE ${alias}.tenant_id = ${tenantSql}::uuid
       AND ${alias}.marca_id = ${marcaSql}
       AND ${alias}.inicio_vigencia <= (${dateSql})::date
       AND ${alias}.cancelled_at IS NULL
     ORDER BY ${alias}.inicio_vigencia DESC
     LIMIT 1
  ) ${alias} ON true`
}

export const buildMarcaCondicaoAtSql = marcaCondicaoAtSql
export const marcaCondicaoLateralSql = marcaCondicaoAtSql

export function conditionPayloadHash(payload) {
  const normalized = normalizarMarcaCondicao(payload)
  return JSON.stringify(normalized)
}
