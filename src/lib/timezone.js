const SAO_PAULO_TZ = 'America/Sao_Paulo'
const SAO_PAULO_OFFSET = '-03:00'
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

function calendarDate(date) {
  if (!DATE_ONLY_RE.test(String(date))) return null
  // PostgreSQL não aceita ano 0000 para DATE/TIMESTAMPTZ.
  if (Number(date.slice(0, 4)) < 1) return null
  const parsed = new Date(`${date}T12:00:00Z`)
  // Date normaliza 2026-02-30 para março; não podemos alargar um filtro por isso.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  return parsed
}

function nextCalendarDate(date) {
  const next = calendarDate(date)
  if (!next) return null
  next.setUTCDate(next.getUTCDate() + 1)
  const year = String(next.getUTCFullYear()).padStart(4, '0')
  const month = String(next.getUTCMonth() + 1).padStart(2, '0')
  const day = String(next.getUTCDate()).padStart(2, '0')
  // PostgreSQL aceita ano 10000, mas toISOString o prefixa com `+` e deixa de
  // ser um literal de data que o parser da rota reconhece.
  return `${year}-${month}-${day}`
}

/**
 * Limites semiabertos de um dia civil em São Paulo.
 *
 * O offset é resolvido pelo PostgreSQL, que conhece as regras históricas de DST;
 * nunca convertemos a coluna para data local no WHERE. Isso preserva a semântica
 * da tela e deixa `iniciado_em` utilizável por índices.
 */
export function saoPauloDayBounds(date) {
  const endDate = nextCalendarDate(date)
  if (!endDate) return null
  return {
    start: `${date}T00:00:00 America/Sao_Paulo`,
    end: `${endDate}T00:00:00 America/Sao_Paulo`,
  }
}

export function saoPauloTimestamp(date, time) {
  return `${date}T${time}:00${SAO_PAULO_OFFSET}`
}

function getParts(value) {
  const date = value instanceof Date
    ? value
    : new Date(DATE_ONLY_RE.test(String(value)) ? `${value}T12:00:00${SAO_PAULO_OFFSET}` : value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

export function saoPauloDateInput(value) {
  const parts = getParts(value)
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : null
}

export function saoPauloTimeInput(value) {
  const parts = getParts(value)
  return parts ? `${parts.hour}:${parts.minute}` : null
}

export function isWeekendInSaoPaulo(value) {
  const date = value instanceof Date
    ? value
    : new Date(DATE_ONLY_RE.test(String(value)) ? `${value}T12:00:00${SAO_PAULO_OFFSET}` : value)
  if (Number.isNaN(date.getTime())) return false
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    weekday: 'short',
  }).format(date)
  return weekday === 'Sat' || weekday === 'Sun'
}
