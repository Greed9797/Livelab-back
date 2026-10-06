import { exactMoneyToCents } from '../lib/money.js'
import { selecionarConsulta } from './financeiro-consulta.js'

const MONTH = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/
const DATE = /^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function dayNumber(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null : Math.floor(date.getTime() / 86_400_000)
}

function monthIndex(value) {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7))
}

function money(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}

export function parseAgingQuery(query = {}) {
  const allowed = new Set(['data_referencia', 'competencia_inicio', 'competencia_fim', 'faixas'])
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key)) throw invalid(`Filtro desconhecido: ${key}`)
    if (typeof value !== 'string') throw invalid(`${key} deve ser único`)
  }
  const { data_referencia, competencia_inicio, competencia_fim, faixas } = query
  if (dayNumber(data_referencia) === null) throw invalid('data_referencia deve ser uma data válida AAAA-MM-DD')
  if (!MONTH.test(competencia_inicio ?? '') || !MONTH.test(competencia_fim ?? '') ||
      competencia_inicio > competencia_fim || monthIndex(competencia_fim) - monthIndex(competencia_inicio) >= 36) {
    throw invalid('competencia_inicio/fim devem cobrir até 36 meses válidos em ordem AAAA-MM')
  }
  if (typeof faixas !== 'string' || !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(faixas)) {
    throw invalid('faixas deve conter limites inteiros positivos separados por vírgula')
  }
  const limites_dias = faixas.split(',').map(Number)
  if (limites_dias.length > 12 || limites_dias.some((n, index) => !Number.isSafeInteger(n) || n > 365_000 || (index > 0 && n <= limites_dias[index - 1]))) {
    throw invalid('faixas deve conter até 12 limites estritamente crescentes (máximo 365000 dias)')
  }
  return { data_referencia, competencia_inicio, competencia_fim, limites_dias }
}

function bucket() {
  return { quantidade: 0, saldo_aberto: 0n }
}

function publicBucket(value) {
  return { quantidade: value.quantidade, saldo_aberto: money(value.saldo_aberto) }
}

/** FIN-06A: só títulos materializados, identificáveis e ainda exigíveis no snapshot. */
export async function selecionarAging(db, { tenantId, data_referencia, competencia_inicio, competencia_fim, limites_dias }) {
  const selecao = await selecionarConsulta(db, {
    tenantId,
    hoje: data_referencia,
    filtros: {
      eixo: 'competencia', inicio: competencia_inicio, fim: competencia_fim,
      competencia_inicio, competencia_fim, natureza: null, origem: null, status: null,
      q: null, valor_min: null, valor_max: null, ordenar: 'data', direcao: 'asc',
    },
  })
  const referencia = dayNumber(data_referencia)
  const vistos = new Set()
  const ambiguos = new Set()
  const candidatos = new Map()
  for (const item of selecao.itens) {
    if (item.id == null || item.origem == null || !['receita', 'custo'].includes(item.natureza)) continue
    const key = JSON.stringify([item.natureza, item.origem, item.id, item.componente ?? null])
    if (vistos.has(key)) {
      // Duas linhas para a mesma obrigação tornam a contagem e o saldo incertos.
      // Omitir ambas evita acusar uma dívida duplicada.
      ambiguos.add(key)
      candidatos.delete(key)
      continue
    }
    vistos.add(key)
    if (item.virtual || item.em_apuracao || item.inconsistente ||
        !['previsto', 'pendente', 'atrasado', 'parcial'].includes(item.status) ||
        item.perdido_em || item.cancelado_em) continue
    const vencimento = dayNumber(item.data_vencimento)
    if (vencimento === null) continue // Sem vencimento contratual, não há atraso comprovado.
    const saldo = exactMoneyToCents(String(item.saldo_aberto))
    if (saldo <= 0n) continue
    candidatos.set(key, { vencimento, saldo })
  }

  const atrasado = bucket()
  const vence_hoje = bucket()
  const futuro = bucket()
  const bins = limites_dias.map(() => bucket())
  bins.push(bucket())
  for (const [key, { vencimento, saldo }] of candidatos) {
    if (ambiguos.has(key)) continue
    const dias = referencia - vencimento
    const alvo = dias > 0 ? atrasado : dias === 0 ? vence_hoje : futuro
    alvo.quantidade++
    alvo.saldo_aberto += saldo
    if (dias > 0) {
      const index = limites_dias.findIndex((limite) => dias <= limite)
      const faixa = bins[index < 0 ? bins.length - 1 : index]
      faixa.quantidade++
      faixa.saldo_aberto += saldo
    }
  }
  return {
    data_referencia, competencia_inicio, competencia_fim, limites_dias,
    atrasado: publicBucket(atrasado), vence_hoje: publicBucket(vence_hoje), futuro: publicBucket(futuro),
    faixas: bins.map((value, index) => ({
      de_dias: index === 0 ? 1 : limites_dias[index - 1] + 1,
      ate_dias: limites_dias[index] ?? null,
      ...publicBucket(value),
    })),
  }
}
