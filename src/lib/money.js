import { z } from 'zod'

export function parseMoneyToDecimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (value == null) return 0
  if (typeof value !== 'string') return 0

  const cleaned = value
    .trim()
    .replace(/\s/g, '')
    .replace(/^R\$/i, '')
    .replace(/[^\d,.-]/g, '')

  if (!cleaned || cleaned === '-' || cleaned === ',' || cleaned === '.') return 0

  let normalized = cleaned
  if (cleaned.includes(',')) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.')
  } else if (cleaned.includes('.')) {
    const parts = cleaned.split('.')
    const last = parts.at(-1) ?? ''
    const thousands = parts.length > 1 && parts.slice(1).every((part) => /^\d{3}$/.test(part))
    normalized = thousands && last.length === 3 ? parts.join('') : cleaned
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

export const moneySchema = z.preprocess(
  (value) => parseMoneyToDecimal(value),
  z.number().min(0),
)

// Contrato novo: SQL NUMERIC(15,2) é recebido como texto. Não passar pelo
// parser permissivo acima ao registrar fatos financeiros: entrada inválida ou
// centavos fracionários devem falhar, nunca virar zero por conveniência da UI.
const MAX_NUMERIC_15_2_CENTS = 999_999_999_999_999n

export function exactMoneyToCents(value) {
  if (typeof value !== 'string' || !/^-?\d{1,13}(?:\.\d{1,2})?$/.test(value)) {
    throw new RangeError('Valor monetário deve ser texto decimal com até duas casas')
  }
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0')
  if (cents > MAX_NUMERIC_15_2_CENTS) throw new RangeError('Valor excede NUMERIC(15,2)')
  return negative ? -cents : cents
}

export function centsToExactMoney(cents) {
  if (typeof cents !== 'bigint' || cents > MAX_NUMERIC_15_2_CENTS || cents < -MAX_NUMERIC_15_2_CENTS) {
    throw new RangeError('Centavos fora de NUMERIC(15,2)')
  }
  const absolute = cents < 0n ? -cents : cents
  return `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

// Método do maior resto. A ordem estável de ids resolve empates sem depender
// da ordem de resposta do banco. Os pesos são inteiros para evitar floats.
export function allocateCentsByWeight(totalCents, allocations) {
  if (typeof totalCents !== 'bigint' || totalCents < 0n || !Array.isArray(allocations) || allocations.length === 0) {
    throw new RangeError('Total e parcelas inválidos')
  }
  const ids = new Set()
  const entries = allocations.map(({ id, weight }) => {
    if (typeof id !== 'string' || !id || ids.has(id) || typeof weight !== 'bigint' || weight < 0n) {
      throw new RangeError('Identificador ou peso inválido')
    }
    ids.add(id)
    return { id, weight }
  })
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0n)
  if (totalWeight === 0n) throw new RangeError('Soma dos pesos deve ser positiva')
  const shares = entries.map(({ id, weight }) => {
    const numerator = totalCents * weight
    return { id, cents: numerator / totalWeight, remainder: numerator % totalWeight }
  })
  let remaining = totalCents - shares.reduce((sum, share) => sum + share.cents, 0n)
  const compareIds = (left, right) => left < right ? -1 : left > right ? 1 : 0
  shares.sort((a, b) => a.remainder === b.remainder
    ? compareIds(a.id, b.id)
    : a.remainder > b.remainder ? -1 : 1)
  for (const share of shares) {
    if (remaining === 0n) break
    share.cents += 1n
    remaining -= 1n
  }
  return shares.sort((a, b) => compareIds(a.id, b.id))
    .map(({ id, cents }) => ({ id, cents }))
}
