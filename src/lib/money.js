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
