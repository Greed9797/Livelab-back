const MONEY_MAX_CENTS = 999_999_999_999_999n

function fail(error) {
  return { ok: false, error }
}

function sourceText(input) {
  return input.trim().replace(/^R\$\s*/i, '').replaceAll('\u00a0', '')
}

function moneyParts(input) {
  const value = sourceText(input)
  if (!value) return null

  if (/^(?:\d+|[1-9]\d{0,2}(?:\.\d{3})+),\d{1,2}$/.test(value)) {
    const [integer, fraction] = value.split(',')
    return { integer: integer.replaceAll('.', ''), fraction }
  }
  if (/^[1-9]\d{0,2}(?:,\d{3})+\.\d{1,2}$/.test(value)) {
    const [integer, fraction] = value.split('.')
    return { integer: integer.replaceAll(',', ''), fraction }
  }
  if (/^[1-9]\d{0,2}(?:\.\d{3})+$/.test(value)) return { integer: value.replaceAll('.', ''), fraction: '' }
  if (/^\d+,\d{1,2}$/.test(value)) {
    const [integer, fraction] = value.split(',')
    return { integer, fraction }
  }
  if (/^\d+\.\d{1,2}$/.test(value)) {
    const [integer, fraction] = value.split('.')
    return { integer, fraction }
  }
  if (/^\d+$/.test(value)) return { integer: value, fraction: '' }
  return null
}

export function parsePortalMoney(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0 || !Number.isInteger(input * 100)) return fail('GMV inválido.')
    input = input.toFixed(2)
  }
  if (typeof input !== 'string') return fail('GMV inválido.')
  const parts = moneyParts(input)
  if (!parts) return fail('GMV inválido.')
  const cents = BigInt(parts.integer) * 100n + BigInt((parts.fraction + '00').slice(0, 2))
  if (cents > MONEY_MAX_CENTS) return fail('GMV acima do limite permitido.')
  return { ok: true, value: `${BigInt(parts.integer).toString()}.${(parts.fraction + '00').slice(0, 2)}` }
}

export function parsePortalCount(input, max) {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) return fail('Número inválido.')
    input = String(input)
  }
  if (typeof input !== 'string') return fail('Número inválido.')
  const value = input.trim()
  const normalized = /^[1-9]\d{0,2}(?:\.\d{3})+$/.test(value)
    ? value.replaceAll('.', '')
    : /^\d+$/.test(value) ? value : null
  if (!normalized) return fail('Número inválido.')
  const parsed = BigInt(normalized)
  if (parsed > BigInt(max)) return fail('Número acima do limite permitido.')
  return { ok: true, value: Number(parsed) }
}
