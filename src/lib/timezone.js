const SAO_PAULO_TZ = 'America/Sao_Paulo'
const SAO_PAULO_OFFSET = '-03:00'

export function saoPauloTimestamp(date, time) {
  return `${date}T${time}:00${SAO_PAULO_OFFSET}`
}

function getParts(value) {
  const date = value instanceof Date ? value : new Date(value)
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
