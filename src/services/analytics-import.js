import { unzipSync, strFromU8 } from 'fflate'

const TZ_OFFSET = '-03:00'
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const HEADER_SCAN_LIMIT = 20

export const SOURCE_TIKTOK_ADS = 'tiktok_ads'
export const SOURCE_TIKTOK_STUDIO = 'tiktok_studio'

// Relatório do TikTok Ads: data/hora vêm como serial + fração do Excel e a marca é uma coluna.
const FIELD_MAP_ADS = {
  marca_nome: ['MARCA', 'Marca', 'marca'],
  excel_date: ['Start time', 'start time', 'Data'],
  start_fraction: ['Start time fraction', '__col_C'],
  duration_seconds: ['Duration', 'duration', '__col_D'],
  attributed_gmv: ['Attributed GMV'],
  attributed_orders: ['Attributed orders'],
  views: ['Views'],
  live_impressions: ['LIVE impressions'],
  product_clicks: ['Product clicks'],
  avg_viewing_duration: ['Avg. viewing duration per viewer', 'Avg. viewing duration'],
  product_impressions: ['Product impressions'],
  new_followers: ['New followers'],
  likes: ['Likes'],
  comments: ['Comments'],
  shares: ['Shares'],
  ads_cost: ['Ads Cost'],
  ads_gmv: ['Ads GMV'],
}

// Relatório "Creator Live Performance" (TikTok Studio): tudo vem como texto, a data/hora é uma
// string local, a duração é "2h37m" e NÃO existe coluna de marca — ela vem da seleção na tela.
const FIELD_MAP_STUDIO = {
  room_id: ['Room ID'],
  room_title: ['Room Title'],
  started_at_text: ['Start Time', 'Start time'],
  ended_at_text: ['End Time', 'End time'],
  duration_text: ['Duration'],
  attributed_gmv: ['Attributed GMV'],
  attributed_orders: ['Attributed orders'],
  views: ['Views'],
  live_impressions: ['Impressions', 'LIVE impressions'],
  product_impressions: ['Product Impressions', 'Product impressions'],
  product_clicks: ['Product clicks', 'Product Clicks'],
  avg_viewing_duration: ['Avg. viewing duration per view', 'Avg. viewing duration per viewer'],
  new_followers: ['New followers'],
  likes: ['Likes'],
  comments: ['Comments'],
  shares: ['Shares'],
}

// Colunas que não têm coluna própria em `lives` e vão preservadas em lives.studio_metrics.
// As taxas do TikTok não são reproduzíveis a partir dos absolutos (cada uma usa um denominador
// diferente — Comment rate usa Views, Like rate usa espectadores únicos, que não vêm na planilha),
// por isso são guardadas como vieram. Percentuais ficam como número percentual (201.57 = 201,57%).
const STUDIO_EXTRA_FIELDS = [
  ['room_title', 'Room Title', 'text'],
  ['items_sold', 'Attributed items sold', 'int'],
  ['sku_orders', 'Attributed SKU orders', 'int'],
  ['customers', 'Customers', 'int'],
  ['aov', 'AOV', 'num'],
  ['impressions_per_hour', 'Impressions Per Hour', 'num'],
  ['gmv_per_hour', 'GMV per hour', 'num'],
  ['show_gpm', 'Show GPM', 'num'],
  ['watch_gpm', 'Watch GPM', 'num'],
  ['avg_viewing_duration_total', 'Avg. viewing duration', 'num'],
  ['tap_through_rate', 'Tap through rate', 'num'],
  ['live_ctr', 'LIVE CTR', 'num'],
  ['ctr', 'CTR', 'num'],
  ['ctor', 'CTOR', 'num'],
  ['ctor_sku_orders', 'CTOR (SKU orders)', 'num'],
  ['sku_order_rate', 'SKU order rate', 'num'],
  ['follow_rate', 'Follow rate', 'num'],
  ['comment_rate', 'Comment rate', 'num'],
  ['share_rate', 'Share rate', 'num'],
  ['like_rate', 'Like rate', 'num'],
]

const FIELD_MAPS = {
  [SOURCE_TIKTOK_ADS]: FIELD_MAP_ADS,
  [SOURCE_TIKTOK_STUDIO]: FIELD_MAP_STUDIO,
}

function xmlUnescape(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function getAttr(attrs, name) {
  const re = new RegExp(`${name}="([^"]*)"`)
  return attrs.match(re)?.[1] ?? null
}

function columnName(cellRef) {
  return String(cellRef ?? '').replace(/[^A-Z]/gi, '').toUpperCase()
}

function parseSharedStrings(xml) {
  const out = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlUnescape(m[1]))
    out.push(parts.join(''))
  }
  return out
}

function parseXlsxRows(buffer) {
  const files = unzipSync(new Uint8Array(buffer))
  const sheetFile = files['xl/worksheets/sheet1.xml']
  if (!sheetFile) throw new Error('Planilha XLSX sem xl/worksheets/sheet1.xml')

  const sharedXml = files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : ''
  const shared = sharedXml ? parseSharedStrings(sharedXml) : []
  const sheetXml = strFromU8(sheetFile)
  const rows = []

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {}
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1]
      const body = cellMatch[2]
      const ref = getAttr(attrs, 'r')
      const col = columnName(ref)
      if (!col) continue
      const type = getAttr(attrs, 't')
      const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1]
      const inline = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1]
      let value = rawValue == null ? inline : xmlUnescape(rawValue)
      if (type === 's' && value != null) value = shared[Number(value)] ?? ''
      row[col] = value == null ? null : xmlUnescape(value)
    }
    if (Object.keys(row).length > 0) rows.push(row)
  }

  if (rows.length < 2) return { source_type: SOURCE_TIKTOK_ADS, records: [] }
  const headerIndex = findHeaderRowIndex(rows)
  const headers = rows[headerIndex]
  const records = rows.slice(headerIndex + 1).map((row) => {
    const record = { __columns: row }
    for (const [col, value] of Object.entries(row)) {
      const header = headers[col]
      if (header) record[header] = value
      if (col === 'C') record['Start time fraction'] = value
      record[`__col_${col}`] = value
    }
    return record
  })
  return { source_type: detectSourceType(headers), records }
}

// Todos os cabeçalhos que o sistema reconhece, em qualquer formato de planilha.
const KNOWN_HEADERS = new Set(
  [
    ...Object.values(FIELD_MAP_ADS).flat(),
    ...Object.values(FIELD_MAP_STUDIO).flat(),
    ...STUDIO_EXTRA_FIELDS.map(([, header]) => header),
  ]
    .filter((header) => !header.startsWith('__'))
    .map((header) => header.toLowerCase()),
)

function countKnownHeaders(row) {
  return Object.values(row)
    .filter((value) => value && KNOWN_HEADERS.has(String(value).trim().toLowerCase()))
    .length
}

/**
 * O Creator Live Performance põe a data na linha 1, deixa a linha 2 vazia e só então o cabeçalho.
 * Em vez de assumir a primeira linha, pega a que mais reconhece cabeçalhos conhecidos.
 */
function findHeaderRowIndex(rows) {
  let best = { index: 0, score: 0 }
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_LIMIT); i++) {
    const score = countKnownHeaders(rows[i])
    if (score > best.score) best = { index: i, score }
  }
  return best.score >= 2 ? best.index : 0
}

function detectSourceType(headerRow) {
  const headers = new Set(
    Object.values(headerRow ?? {}).map((value) => String(value ?? '').trim().toLowerCase()),
  )
  return headers.has('room id') ? SOURCE_TIKTOK_STUDIO : SOURCE_TIKTOK_ADS
}

function detectDelimiter(line) {
  const candidates = [',', ';', '\t']
  return candidates
    .map((delimiter) => ({ delimiter, count: splitCsvLine(line, delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ','
}

function splitCsvLine(line, delimiter) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (ch === delimiter && !quoted) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function parseCsvRows(buffer) {
  const text = Buffer.from(buffer).toString('utf8').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) return { source_type: SOURCE_TIKTOK_ADS, records: [] }
  const delimiter = detectDelimiter(lines[0])
  const headerLineIndex = findHeaderLineIndex(lines, delimiter)
  const headers = splitCsvLine(lines[headerLineIndex], delimiter).map((h) => h.trim())
  const records = lines.slice(headerLineIndex + 1).map((line) => {
    const cols = splitCsvLine(line, delimiter)
    const record = { __columns: {} }
    headers.forEach((header, index) => {
      const value = cols[index]?.trim() ?? ''
      if (header) record[header] = value
      const col = String.fromCharCode(65 + index)
      record.__columns[col] = value
      record[`__col_${col}`] = value
    })
    if (!record['Start time fraction']) record['Start time fraction'] = record.__col_C
    return record
  })
  return { source_type: detectSourceType(headers), records }
}

function findHeaderLineIndex(lines, delimiter) {
  let best = { index: 0, score: 0 }
  for (let i = 0; i < Math.min(lines.length, HEADER_SCAN_LIMIT); i++) {
    const cols = splitCsvLine(lines[i], delimiter).map((value) => value.trim())
    const score = countKnownHeaders(cols)
    if (score > best.score) best = { index: i, score }
  }
  return best.score >= 2 ? best.index : 0
}

function pick(record, names) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== '') return record[name]
  }
  return null
}

export function parseImportNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw || raw === '#DIV/0!' || raw === '-' || raw.toLowerCase() === 'nan') return null
  let s = raw.replace(/\s/g, '').replace(/R\$/gi, '').replace(/%/g, '')
  const hasComma = s.includes(',')
  const hasDot = s.includes('.')
  if (hasComma && hasDot) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '')
  } else if (hasComma) {
    s = s.replace(',', '.')
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function excelSerialToDate(value) {
  const serial = parseImportNumber(value)
  if (serial == null) return null
  const date = new Date(EXCEL_EPOCH_MS + Math.floor(serial) * 86400000)
  return date.toISOString().slice(0, 10)
}

function fractionToTime(value) {
  const fraction = parseImportNumber(value)
  if (fraction == null) return null
  const totalMinutes = Math.round((((fraction % 1) + 1) % 1) * 24 * 60)
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/**
 * Duração em texto do Creator Live Performance: "2h37m", "1h", "45m", "01:23:45", "90".
 * parseImportNumber sozinho devolveria 2 para "2h37m" — por isso este parser existe.
 */
export function parseDurationToSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null
  const raw = String(value ?? '').trim()
  if (!raw) return null

  if (raw.includes(':')) {
    const parts = raw.split(':').map((part) => Number(part.trim()))
    if (parts.some((part) => !Number.isFinite(part))) return null
    const [h, m, s] = parts.length === 2 ? [parts[0], parts[1], 0] : parts
    return Math.round(h * 3600 + m * 60 + (s ?? 0))
  }

  // Sem \b: em "2h37m" o 'h' é seguido de dígito, então não há fronteira de palavra e o "2h"
  // seria descartado. Alternativas em ordem decrescente para "horas" vencer "h".
  const unit = raw.match(/(\d+(?:[.,]\d+)?)\s*(horas|hora|hrs|hr|h|mins|min|m|segs|seg|s)/gi)
  if (unit) {
    let total = 0
    for (const part of unit) {
      const amount = Number(part.match(/\d+(?:[.,]\d+)?/)[0].replace(',', '.'))
      const suffix = part.replace(/[\d.,\s]/g, '').toLowerCase()
      if (suffix.startsWith('h')) total += amount * 3600
      else if (suffix.startsWith('m')) total += amount * 60
      else total += amount
    }
    return Math.round(total)
  }

  const plain = parseImportNumber(raw)
  return plain == null ? null : Math.round(plain)
}

/**
 * "2026-07-23 08:09:17" → "2026-07-23T08:09:17-03:00".
 * A planilha vem em horário local; o banco roda em UTC. Sem a âncora de fuso, `new Date()` no
 * Railway interpretaria a string como UTC e jogaria a live 3 horas para frente.
 */
export function parseDateTimeLocal(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso
    return `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:${s ?? '00'}${TZ_OFFSET}`
  }

  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[T ]?(\d{1,2})?:?(\d{2})?(?::(\d{2}))?/)
  if (br) {
    const [, d, mo, y, h, mi, s] = br
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${(h ?? '00').padStart(2, '0')}:${mi ?? '00'}:${s ?? '00'}${TZ_OFFSET}`
  }

  return null
}

function localDateOf(isoWithOffset) {
  return isoWithOffset ? isoWithOffset.slice(0, 10) : null
}

function localTimeOf(isoWithOffset) {
  return isoWithOffset ? isoWithOffset.slice(11, 16) : null
}

function addSecondsToIso(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString()
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function normalizeBrandName(value) {
  return normalizeText(value)
}

function normalizeRow(record, rowIndex, sourceType) {
  return sourceType === SOURCE_TIKTOK_STUDIO
    ? normalizeRowStudio(record, rowIndex)
    : normalizeRowAds(record, rowIndex)
}

/**
 * O Creator Live Performance não traz marca: ela vem da seleção feita na tela de importação e é
 * aplicada depois, no preview. Aqui só o que a planilha realmente diz.
 */
function normalizeRowStudio(record, rowIndex) {
  const FIELD_MAP = FIELD_MAP_STUDIO
  const startedAt = parseDateTimeLocal(pick(record, FIELD_MAP.started_at_text))
  const endedAtRaw = parseDateTimeLocal(pick(record, FIELD_MAP.ended_at_text))
  const durationText = pick(record, FIELD_MAP.duration_text)
  const durationFromText = parseDurationToSeconds(durationText)
  const durationFromRange = startedAt && endedAtRaw
    ? Math.round((new Date(endedAtRaw).getTime() - new Date(startedAt).getTime()) / 1000)
    : null
  // A duração em texto é arredondada ao minuto ("2h37m"); o intervalo real é mais preciso.
  const durationSeconds = durationFromRange && durationFromRange > 0
    ? durationFromRange
    : (durationFromText ?? 0)
  const endedAt = endedAtRaw
    ?? (startedAt && durationSeconds > 0 ? addSecondsToIso(startedAt, durationSeconds) : null)

  // 19 dígitos: estoura Number.MAX_SAFE_INTEGER, então nunca passa por parseImportNumber.
  const roomId = String(pick(record, FIELD_MAP.room_id) ?? '').trim() || null

  const studioMetrics = {}
  for (const [key, header, kind] of STUDIO_EXTRA_FIELDS) {
    const value = pick(record, [header])
    if (value === null || value === undefined || value === '') continue
    if (kind === 'text') studioMetrics[key] = String(value).trim()
    else {
      const parsed = parseImportNumber(value)
      if (parsed != null) studioMetrics[key] = kind === 'int' ? Math.round(parsed) : parsed
    }
  }

  const normalized = {
    row_index: rowIndex,
    source_type: SOURCE_TIKTOK_STUDIO,
    room_id: roomId,
    room_title: studioMetrics.room_title ?? null,
    marca_nome: '',
    marca_key: '',
    live_date: localDateOf(startedAt),
    start_time: localTimeOf(startedAt),
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    duration_hours: durationSeconds > 0 ? durationSeconds / 3600 : null,
    attributed_gmv: parseImportNumber(pick(record, FIELD_MAP.attributed_gmv)),
    attributed_orders: Math.round(parseImportNumber(pick(record, FIELD_MAP.attributed_orders)) ?? 0),
    views: Math.round(parseImportNumber(pick(record, FIELD_MAP.views)) ?? 0),
    live_impressions: Math.round(parseImportNumber(pick(record, FIELD_MAP.live_impressions)) ?? 0),
    product_clicks: Math.round(parseImportNumber(pick(record, FIELD_MAP.product_clicks)) ?? 0),
    avg_viewing_duration: parseImportNumber(pick(record, FIELD_MAP.avg_viewing_duration)),
    product_impressions: Math.round(parseImportNumber(pick(record, FIELD_MAP.product_impressions)) ?? 0),
    new_followers: Math.round(parseImportNumber(pick(record, FIELD_MAP.new_followers)) ?? 0),
    likes: Math.round(parseImportNumber(pick(record, FIELD_MAP.likes)) ?? 0),
    comments: Math.round(parseImportNumber(pick(record, FIELD_MAP.comments)) ?? 0),
    shares: Math.round(parseImportNumber(pick(record, FIELD_MAP.shares)) ?? 0),
    ads_cost: null,
    ads_gmv: null,
    studio_metrics: studioMetrics,
  }

  const errors = []
  if (!normalized.started_at) errors.push('data/hora ausente')
  if (!normalized.duration_seconds || normalized.duration_seconds <= 0) errors.push('duracao ausente')

  return { row_index: rowIndex, raw: record, normalized, errors }
}

function normalizeRowAds(record, rowIndex) {
  const FIELD_MAP = FIELD_MAP_ADS
  const marcaNome = String(pick(record, FIELD_MAP.marca_nome) ?? '').trim()
  const liveDate = excelSerialToDate(pick(record, FIELD_MAP.excel_date))
  const startTime = fractionToTime(pick(record, FIELD_MAP.start_fraction))
  const durationSeconds = Math.round(parseImportNumber(pick(record, FIELD_MAP.duration_seconds)) ?? 0)
  const startedAt = liveDate && startTime ? `${liveDate}T${startTime}:00${TZ_OFFSET}` : null
  const endedAt = startedAt && durationSeconds > 0 ? addSecondsToIso(startedAt, durationSeconds) : null

  const normalized = {
    row_index: rowIndex,
    source_type: SOURCE_TIKTOK_ADS,
    marca_nome: marcaNome,
    marca_key: normalizeBrandName(marcaNome),
    live_date: liveDate,
    start_time: startTime,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    duration_hours: durationSeconds > 0 ? durationSeconds / 3600 : null,
    attributed_gmv: parseImportNumber(pick(record, FIELD_MAP.attributed_gmv)),
    attributed_orders: Math.round(parseImportNumber(pick(record, FIELD_MAP.attributed_orders)) ?? 0),
    views: Math.round(parseImportNumber(pick(record, FIELD_MAP.views)) ?? 0),
    live_impressions: Math.round(parseImportNumber(pick(record, FIELD_MAP.live_impressions)) ?? 0),
    product_clicks: Math.round(parseImportNumber(pick(record, FIELD_MAP.product_clicks)) ?? 0),
    avg_viewing_duration: parseImportNumber(pick(record, FIELD_MAP.avg_viewing_duration)),
    product_impressions: Math.round(parseImportNumber(pick(record, FIELD_MAP.product_impressions)) ?? 0),
    new_followers: Math.round(parseImportNumber(pick(record, FIELD_MAP.new_followers)) ?? 0),
    likes: Math.round(parseImportNumber(pick(record, FIELD_MAP.likes)) ?? 0),
    comments: Math.round(parseImportNumber(pick(record, FIELD_MAP.comments)) ?? 0),
    shares: Math.round(parseImportNumber(pick(record, FIELD_MAP.shares)) ?? 0),
    ads_cost: parseImportNumber(pick(record, FIELD_MAP.ads_cost)),
    ads_gmv: parseImportNumber(pick(record, FIELD_MAP.ads_gmv)),
  }

  const errors = []
  if (!normalized.marca_key) errors.push('marca ausente')
  if (!normalized.live_date || !normalized.start_time || !normalized.started_at) errors.push('data/hora ausente')
  if (!normalized.duration_seconds || normalized.duration_seconds <= 0) errors.push('duracao ausente')

  return { row_index: rowIndex, raw: record, normalized, errors }
}

/**
 * @returns {{ source_type: string, rows: Array }} formato detectado pelos cabeçalhos + linhas normalizadas.
 */
export function parseAnalyticsImportBuffer({ buffer, filename }) {
  const lower = String(filename ?? '').toLowerCase()
  const { source_type: sourceType, records } = lower.endsWith('.xlsx') || lower.endsWith('.xlsm')
    ? parseXlsxRows(buffer)
    : parseCsvRows(buffer)

  const rows = records
    .map((record, index) => normalizeRow(record, index + 1, sourceType))
    .filter((row) => (
      row.normalized.marca_nome
      || row.normalized.room_id
      || row.normalized.duration_seconds
      || row.normalized.ads_gmv != null
      || row.normalized.attributed_gmv != null
    ))

  return { source_type: sourceType, rows }
}

export async function loadAnalyticsImportCandidates(db, { fromDate, toDate }) {
  const result = await db.query(`
    SELECT
      l.id AS live_id,
      COALESCE(l.agenda_evento_id, ae.id) AS agenda_evento_id,
      COALESCE(l.marca_id, ae.marca_id) AS marca_id,
      COALESCE(m.nome, m_agenda.nome, cl.nome) AS marca_nome,
      l.iniciado_em,
      COALESCE(l.encerrado_em, l.previsto_fim, ae.data_fim, l.iniciado_em + interval '6 hours') AS encerrado_em
    FROM lives l
    LEFT JOIN agenda_eventos ae
      ON ae.tenant_id = l.tenant_id
     AND (ae.id = l.agenda_evento_id OR ae.live_id = l.id)
    LEFT JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
    LEFT JOIN marcas m_agenda ON m_agenda.id = ae.marca_id AND m_agenda.tenant_id = l.tenant_id
    LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
    WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
      AND (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date >= ($1::date - interval '1 day')::date
      AND (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date <= ($2::date + interval '1 day')::date
      AND l.status <> 'cancelada'
  `, [fromDate, toDate])

  return result.rows.map((row) => ({
    ...row,
    marca_key: normalizeBrandName(row.marca_nome),
    start_ms: new Date(row.iniciado_em).getTime(),
    end_ms: new Date(row.encerrado_em).getTime(),
  }))
}

function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / 1000
}

/**
 * @param {{ marcaId?: string|null }} options marca escolhida na tela — usada quando a planilha
 *   não traz coluna de marca (Creator Live Performance), para restringir os candidatos.
 */
export function matchAnalyticsImportRows(rows, candidates, { marcaId = null } = {}) {
  return rows.map((row) => {
    const n = row.normalized
    if (row.errors.length > 0) {
      return { ...row, match_status: 'invalid', match_reason: row.errors.join(', '), candidates: [] }
    }
    if (n.duration_seconds < 300) {
      return { ...row, match_status: 'skipped_short', match_reason: 'live com menos de 5 minutos', candidates: [] }
    }

    const rowStart = new Date(n.started_at).getTime()
    const rowEnd = new Date(n.ended_at).getTime()
    const matches = candidates
      .filter((candidate) => (n.marca_key
        ? candidate.marca_key === n.marca_key
        : !marcaId || String(candidate.marca_id) === String(marcaId)))
      .map((candidate) => {
        const candDuration = Math.max(1, (candidate.end_ms - candidate.start_ms) / 1000)
        const overlap = overlapSeconds(rowStart, rowEnd, candidate.start_ms, candidate.end_ms)
        const score = overlap / Math.max(1, Math.min(n.duration_seconds, candDuration))
        return {
          live_id: candidate.live_id,
          agenda_evento_id: candidate.agenda_evento_id,
          marca_nome: candidate.marca_nome,
          iniciado_em: candidate.iniciado_em,
          encerrado_em: candidate.encerrado_em,
          overlap_seconds: Math.round(overlap),
          start_delta_seconds: Math.round(Math.abs(candidate.start_ms - rowStart) / 1000),
          score: Number(score.toFixed(4)),
        }
      })
      .filter((candidate) => candidate.overlap_seconds > 0)
      .sort((a, b) => b.score - a.score || b.overlap_seconds - a.overlap_seconds || a.start_delta_seconds - b.start_delta_seconds)

    if (matches.length === 0) {
      return { ...row, match_status: 'unmatched', match_reason: 'sem live da mesma marca com sobreposicao no dia', candidates: [] }
    }

    const [best, second] = matches
    const ambiguous = second && second.score > 0 && (best.score - second.score) < 0.15
    if (ambiguous) {
      return {
        ...row,
        match_status: 'ambiguous',
        match_reason: 'mais de uma live candidata com sobreposicao parecida',
        candidates: matches.slice(0, 5),
      }
    }

    return {
      ...row,
      match_status: 'matched',
      match_reason: `sobreposicao ${Math.round(best.score * 100)}%`,
      match_confidence: best.score,
      matched_live_id: best.live_id,
      matched_agenda_evento_id: best.agenda_evento_id,
      candidates: matches.slice(0, 5),
    }
  })
}

export function summarizeImportRows(rows) {
  const summary = {
    total_rows: rows.length,
    matched_rows: 0,
    ambiguous_rows: 0,
    unmatched_rows: 0,
    skipped_rows: 0,
    invalid_rows: 0,
  }
  for (const row of rows) {
    if (row.match_status === 'matched') summary.matched_rows++
    else if (row.match_status === 'ambiguous') summary.ambiguous_rows++
    else if (row.match_status === 'skipped_short') summary.skipped_rows++
    else if (row.match_status === 'invalid') summary.invalid_rows++
    else summary.unmatched_rows++
  }
  return summary
}
