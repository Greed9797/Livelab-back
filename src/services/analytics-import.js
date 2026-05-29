import { unzipSync, strFromU8 } from 'fflate'

const TZ_OFFSET = '-03:00'
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)

const FIELD_MAP = {
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

  if (rows.length < 2) return []
  const headers = rows[0]
  return rows.slice(1).map((row) => {
    const record = { __columns: row }
    for (const [col, value] of Object.entries(row)) {
      const header = headers[col]
      if (header) record[header] = value
      if (col === 'C') record['Start time fraction'] = value
      record[`__col_${col}`] = value
    }
    return record
  })
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
  if (lines.length < 2) return []
  const delimiter = detectDelimiter(lines[0])
  const headers = splitCsvLine(lines[0], delimiter).map((h) => h.trim())
  return lines.slice(1).map((line) => {
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

function normalizeRow(record, rowIndex) {
  const marcaNome = String(pick(record, FIELD_MAP.marca_nome) ?? '').trim()
  const liveDate = excelSerialToDate(pick(record, FIELD_MAP.excel_date))
  const startTime = fractionToTime(pick(record, FIELD_MAP.start_fraction))
  const durationSeconds = Math.round(parseImportNumber(pick(record, FIELD_MAP.duration_seconds)) ?? 0)
  const startedAt = liveDate && startTime ? `${liveDate}T${startTime}:00${TZ_OFFSET}` : null
  const endedAt = startedAt && durationSeconds > 0 ? addSecondsToIso(startedAt, durationSeconds) : null

  const normalized = {
    row_index: rowIndex,
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

export function parseAnalyticsImportBuffer({ buffer, filename }) {
  const lower = String(filename ?? '').toLowerCase()
  const records = lower.endsWith('.xlsx') || lower.endsWith('.xlsm')
    ? parseXlsxRows(buffer)
    : parseCsvRows(buffer)

  return records
    .map((record, index) => normalizeRow(record, index + 1))
    .filter((row) => row.normalized.marca_nome || row.normalized.duration_seconds || row.normalized.ads_gmv != null)
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

export function matchAnalyticsImportRows(rows, candidates) {
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
      .filter((candidate) => candidate.marca_key === n.marca_key)
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
