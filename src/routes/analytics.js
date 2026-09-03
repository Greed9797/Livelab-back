import { z } from 'zod'
import { READ_ANALYTICS, WRITE_LIVES } from '../config/role_groups.js'
import {
  loadAnalyticsImportCandidates,
  matchAnalyticsImportRows,
  parseAnalyticsImportBuffer,
  summarizeImportRows,
  SOURCE_TIKTOK_STUDIO,
} from '../services/analytics-import.js'
import { aplicarRetroLiftDoMes, calcularComissoesDaLive } from '../services/commission-engine.js'
import { getPerformanceRanking } from '../lib/performance-rollups.js'
import { liveGmvSql } from '../lib/metric-sql.js'
import { applyApresentadorasToLive, rateioAbsoluto } from '../lib/live-rateio.js'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { withCache, buildCacheKey, setCacheControl, invalidateTenant } from '../lib/dashboard-cache.js'
import { invalidateHomeDashboard } from './home.js'

const ANALYTICS_DASHBOARD_CACHE_TTL_MS = Number(process.env.ANALYTICS_DASHBOARD_CACHE_TTL_MS ?? 60_000)
const ANALYTICS_DIARIO_CACHE_TTL_MS = Number(process.env.ANALYTICS_DIARIO_CACHE_TTL_MS ?? 60_000)

const ANALYTICS_TZ = 'America/Sao_Paulo'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function round2(value) {
  return parseFloat(Number(value ?? 0).toFixed(2))
}

function round1(value) {
  return parseFloat(Number(value ?? 0).toFixed(1))
}

function toInt(value) {
  return Number(value ?? 0)
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ANALYTICS_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${byType.year}-${byType.month}`
}

function monthEnd(monthValue) {
  const [year, month] = monthValue.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function isValidDateString(value) {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isValidMonthString(value) {
  if (!MONTH_RE.test(value)) return false
  const month = Number(value.slice(5, 7))
  return month >= 1 && month <= 12
}

function resolveAnalyticsPeriod(query) {
  const { from, to, mesAno, mes, ano } = query

  if (from || to) {
    if (!from || !to || !isValidDateString(from) || !isValidDateString(to)) {
      return { error: 'from/to must be YYYY-MM-DD' }
    }
    if (from > to) return { error: 'from must be before or equal to to' }
    return { fromDate: from, toDate: to, mesAno: from.slice(0, 7) }
  }

  const monthValue = mesAno ?? (mes && ano ? `${ano}-${String(mes).padStart(2, '0')}` : currentMonth())
  if (!isValidMonthString(monthValue)) return { error: 'mesAno must be YYYY-MM' }

  return {
    fromDate: `${monthValue}-01`,
    toDate: monthEnd(monthValue),
    mesAno: monthValue,
  }
}

const MAX_IMPORT_ROWS = 5000

// Teto da entrada de máquina. Ela faz preview e apply na mesma requisição, e o
// apply custa várias idas ao banco por linha — 5.000 linhas não terminam antes
// de o Railway cortar a conexão.
const MAX_INGEST_ROWS = Number(process.env.MAX_INGEST_ROWS ?? 1000)

// Sobreposição mínima para a automação vincular sozinha. Abaixo disso a linha
// espera revisão humana.
const CONFIANCA_MINIMA_INGEST = 0.8

/** Duas casas decimais — a escala de NUMERIC(_,2), tanto em percentual_rateio quanto em gmv_rateado. */
const duasCasas = (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6

const importRowPatchSchema = z.object({
  decisao: z.enum(['pendente', 'vincular', 'criar', 'ignorar']).optional(),
  marca_id: z.string().uuid().optional(),
  cabine_id: z.string().uuid().nullable().optional(),
  matched_live_id: z.string().uuid().nullable().optional(),
  apresentadoras: z.array(z.object({
    apresentadora_id: z.string().uuid(),
    // Rateio absoluto: o que a pessoa realmente digita na revisão ("a Ana fez 4h e vendeu
    // R$ 3.000"). É a forma preferida — não passa por porcentagem, então não arredonda.
    gmv: z.number().min(0).refine(duasCasas, { message: 'Use no máximo 2 casas decimais no GMV' }).optional(),
    segundos: z.number().int().min(0).optional(),
    // Percentual continua aceito para não invalidar lotes salvos antes desta mudança.
    // percentual_rateio é NUMERIC(5,2): mais casas seriam arredondadas no banco e a soma
    // deixaria de fechar 100 (33.335 × 3 passaria aqui e viraria 100.02 gravado).
    percentual: z.number().positive().max(100).refine(
      duasCasas,
      { message: 'Use no máximo 2 casas decimais no percentual' },
    ).optional(),
  })).min(1).optional(),
}).refine(
  // Modo misto silenciosamente ratearia metade por valor e metade por porcentagem.
  (data) => !data.apresentadoras || data.apresentadoras.every(rateioAbsoluto)
    || data.apresentadoras.every((item) => item.percentual != null),
  { message: 'Informe valor (R$ e tempo) para todas as apresentadoras, ou percentual para todas' },
).refine(
  // Só vale para o formato legado: no absoluto quem fecha a conta é o total da live, no apply.
  (data) => !data.apresentadoras || data.apresentadoras.some(rateioAbsoluto)
    || data.apresentadoras.reduce((acc, item) => acc + Math.round(item.percentual * 100), 0) === 10000,
  { message: 'O rateio das apresentadoras precisa somar exatamente 100%' },
).refine(
  (data) => !data.apresentadoras
    || new Set(data.apresentadoras.map((item) => item.apresentadora_id)).size === data.apresentadoras.length,
  { message: 'Apresentadora repetida no rateio' },
)

async function readAnalyticsImportUpload(request) {
  let upload
  let fields = {}

  if (request.isMultipart?.()) {
    const file = await request.file()
    if (!file) throw new Error('Arquivo CSV/XLSX obrigatorio')
    fields = file.fields ?? {}
    upload = { filename: file.filename, buffer: await file.toBuffer() }
  } else {
    const body = request.body ?? {}
    if (body.content_base64) {
      upload = {
        filename: body.filename ?? 'analytics-import.xlsx',
        buffer: Buffer.from(String(body.content_base64), 'base64'),
      }
    } else if (body.content) {
      upload = {
        filename: body.filename ?? 'analytics-import.csv',
        buffer: Buffer.from(String(body.content), 'utf8'),
      }
    } else {
      throw new Error('Envie multipart file ou content_base64')
    }
    fields = body
  }

  assertUploadLooksLikeSpreadsheet(upload)
  return { ...upload, fields }
}

/**
 * O mimetype declarado no multipart não é confiável (mesma ressalva de src/lib/image_upload.js).
 * XLSX é um zip: tem que começar com "PK".
 */
function assertUploadLooksLikeSpreadsheet({ filename, buffer }) {
  if (!buffer?.length) throw new Error('Arquivo vazio')
  const lower = String(filename ?? '').toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error('Arquivo .xlsx invalido (nao e um arquivo XLSX)')
    }
  }
}

/** Campo enviado como query string (padrão do apiUpload do front) ou como campo do multipart. */
function readUploadField(request, fields, name) {
  const fromQuery = request.query?.[name]
  if (fromQuery) return String(fromQuery)
  const field = fields?.[name]
  if (!field) return null
  const value = typeof field === 'object' && 'value' in field ? field.value : field
  return value ? String(value) : null
}

/**
 * Decisão inicial sugerida por linha. O usuário revisa e altera antes do apply.
 * Nada é aplicado sem uma decisão explícita de 'vincular' ou 'criar'.
 */
function defaultDecisionFor(matchStatus) {
  if (matchStatus === 'matched') return 'vincular'
  if (matchStatus === 'skipped_short' || matchStatus === 'invalid') return 'ignorar'
  return 'pendente'
}

/**
 * Decisão da entrada de máquina, no lugar do humano que revisaria na tela.
 *
 * A régua é a confiança do casamento: `matched` com sobreposição folgada entra
 * sozinho, o resto fica pendente. Um agente que aplica o duvidoso escreve GMV na
 * live errada, e o erro só aparece na comissão do fim do mês.
 */
function decisaoAutomatica(row, { criarLives = false } = {}) {
  if (row.match_status === 'skipped_short' || row.match_status === 'invalid') return 'ignorar'
  if (row.match_status === 'matched' && Number(row.match_confidence ?? 0) >= CONFIANCA_MINIMA_INGEST) {
    return 'vincular'
  }
  if (row.match_status === 'unmatched' && criarLives) return 'criar'
  return 'pendente'
}

function rowResponse(row) {
  return {
    id: row.id ?? null,
    row_index: row.row_index,
    marca_nome: row.normalized?.marca_nome ?? row.marca_nome,
    live_date: row.normalized?.live_date ?? row.live_date,
    start_time: row.normalized?.start_time ?? row.start_time,
    duration_seconds: row.normalized?.duration_seconds ?? row.duration_seconds,
    room_id: row.normalized?.room_id ?? null,
    room_title: row.normalized?.room_title ?? null,
    attributed_gmv: row.normalized?.attributed_gmv ?? null,
    likes: row.normalized?.likes ?? null,
    comments: row.normalized?.comments ?? null,
    like_rate: row.normalized?.studio_metrics?.like_rate ?? null,
    ads_gmv: row.normalized?.ads_gmv ?? null,
    ads_cost: row.normalized?.ads_cost ?? null,
    attributed_orders: row.normalized?.attributed_orders ?? null,
    views: row.normalized?.views ?? null,
    match_status: row.match_status,
    match_reason: row.match_reason,
    match_confidence: row.match_confidence ?? null,
    matched_live_id: row.matched_live_id ?? null,
    matched_agenda_evento_id: row.matched_agenda_evento_id ?? null,
    candidates: row.candidates ?? [],
    error: row.error ?? null,
  }
}

/**
 * GMV oficial da linha. No Creator Live Performance é o "Attributed GMV"; no relatório de Ads
 * continua sendo o "Ads GMV". Vai para lives.ads_gmv, que é o topo de
 * COALESCE(ads_gmv, manual_gmv, fat_gerado) em src/lib/metric-sql.js — ou seja, passa a valer
 * em todos os dashboards e no cálculo de comissão.
 */
function officialGmvOf(normalized) {
  return normalized?.source_type === SOURCE_TIKTOK_STUDIO
    ? (normalized.attributed_gmv ?? null)
    : (normalized?.ads_gmv ?? null)
}

/** Live nova precisa de cabine (NOT NULL): usa a mais recente da marca, senão qualquer ativa. */
async function resolveCabinePadrao(db, tenantId, marcaId) {
  if (marcaId) {
    const daMarca = await db.query(
      `SELECT cabine_id FROM lives
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND cabine_id IS NOT NULL
        ORDER BY iniciado_em DESC LIMIT 1`,
      [tenantId, marcaId],
    )
    if (daMarca.rows[0]?.cabine_id) return daMarca.rows[0].cabine_id
  }
  const qualquer = await db.query(
    `SELECT id FROM cabines
      WHERE tenant_id = $1::uuid AND COALESCE(ativo, true) AND deleted_at IS NULL
      ORDER BY numero NULLS LAST LIMIT 1`,
    [tenantId],
  )
  if (!qualquer.rows[0]?.id) throw new Error('Nenhuma cabine ativa para criar a live')
  return qualquer.rows[0].id
}

/**
 * Decide em qual live a linha será aplicada.
 * 'vincular' usa a live escolhida na revisão. 'criar' primeiro procura uma live com o mesmo
 * Room ID — reimportar a mesma planilha atualiza, não duplica.
 */
async function resolveTargetLive(db, { tenantId, row, normalized, batch, cabinePadraoId }) {
  if (row.decisao === 'vincular') {
    if (!row.matched_live_id) throw new Error('Linha marcada para vincular sem live selecionada')
    const existe = await db.query(
      'SELECT id FROM lives WHERE id = $1::uuid AND tenant_id = $2::uuid',
      [row.matched_live_id, tenantId],
    )
    if (existe.rowCount === 0) throw new Error('Live selecionada nao encontrada')
    return row.matched_live_id
  }

  if (normalized.room_id) {
    const mesmoRoom = await db.query(
      'SELECT id FROM lives WHERE tenant_id = $1::uuid AND tiktok_room_id = $2',
      [tenantId, normalized.room_id],
    )
    if (mesmoRoom.rows[0]?.id) return mesmoRoom.rows[0].id
  }

  const marcaId = row.marca_id ?? batch.marca_id
  if (!marcaId) throw new Error('Marca obrigatoria para criar a live')
  if (!normalized.started_at) throw new Error('Linha sem data/hora de inicio')

  // Cabine confirmada na revisão manda; o palpite do lote é só o fallback.
  const cabineId = row.cabine_id ?? cabinePadraoId
  if (!cabineId) throw new Error('Cabine obrigatoria para criar a live')

  // A FK de analytics_import_rows.cabine_id é só REFERENCES cabines(id), sem amarrar tenant, e
  // a role do Supabase tem BYPASSRLS. O PATCH já checa, mas o valor fica persistido entre o
  // PATCH e o apply: revalidar aqui é o que impede um tenant de criar live na cabine de outro.
  if (row.cabine_id) {
    const daCasa = await db.query(
      'SELECT 1 FROM cabines WHERE id = $1::uuid AND tenant_id = $2::uuid',
      [row.cabine_id, tenantId],
    )
    if (daCasa.rowCount === 0) throw new Error('Cabine selecionada nao encontrada')
  }

  const inserted = await db.query(
    `INSERT INTO lives (
       tenant_id, cabine_id, marca_id, status, iniciado_em, encerrado_em,
       tipo, status_publicacao, origem_dados, tiktok_room_id, resumo
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'encerrada', $4::timestamptz, $5::timestamptz,
             'cliente', 'rascunho', 'api', $6, $7)
     RETURNING id`,
    [
      tenantId,
      cabineId,
      marcaId,
      normalized.started_at,
      normalized.ended_at ?? normalized.started_at,
      normalized.room_id ?? null,
      normalized.room_title ?? null,
    ],
  )
  return inserted.rows[0].id
}

async function applyMetricsToLive(db, { tenantId, liveId, normalized: n, batchId, rowId }) {
  // ads_gmv é o topo de COALESCE(ads_gmv, manual_gmv, fat_gerado): é ele que manda no número
  // exibido. Desde que a tela voltou a permitir corrigi-lo, sobrescrever aqui apagaria a
  // correção humana em silêncio numa reimportação — o mesmo pecado do "editei e voltou
  // sozinho" que já aconteceu 3x em produção. Existir linha em live_metric_revisions com
  // campo='ads_gmv' é prova de correção manual: essa tabela só é escrita pelo PATCH da live,
  // nunca por este import.
  const updated = await db.query(
    `UPDATE lives
        SET ads_gmv = CASE
              WHEN EXISTS (
                SELECT 1 FROM live_metric_revisions r
                 WHERE r.live_id = lives.id
                   AND r.tenant_id = lives.tenant_id
                   AND r.campo = 'ads_gmv'
              ) THEN ads_gmv
              ELSE $1
            END,
            ads_cost = COALESCE($2, ads_cost),
            live_impressions = $3,
            product_impressions = $4,
            product_clicks = $5,
            avg_viewing_duration = $6,
            new_followers = $7,
            manual_views = $8,
            manual_comments = $9,
            manual_likes = $10,
            manual_shares = $11,
            manual_orders = $12,
            tiktok_room_id = COALESCE($13, tiktok_room_id),
            studio_metrics = COALESCE($14::jsonb, studio_metrics),
            encerrado_em = COALESCE($15::timestamptz, encerrado_em),
            ads_import_batch_id = $16::uuid,
            ads_import_row_id = $17::uuid,
            ads_metrics_updated_at = NOW()
      WHERE id = $18::uuid
        AND tenant_id = $19::uuid
    RETURNING ads_gmv, (ads_gmv IS DISTINCT FROM $1) AS gmv_preservado`,
    [
      officialGmvOf(n),
      n.ads_cost ?? null,
      n.live_impressions ?? null,
      n.product_impressions ?? null,
      n.product_clicks ?? null,
      n.avg_viewing_duration ?? null,
      n.new_followers ?? null,
      n.views ?? null,
      n.comments ?? null,
      n.likes ?? null,
      n.shares ?? null,
      n.attributed_orders ?? null,
      n.room_id ?? null,
      n.studio_metrics ? JSON.stringify(n.studio_metrics) : null,
      n.ended_at ?? null,
      batchId,
      rowId,
      liveId,
      tenantId,
    ],
  )
  // gmvPreservado = a live tinha correção manual e o valor da planilha NÃO entrou. O apply
  // devolve essa contagem para a tela dizer o que preservou; preservar em silêncio esconderia
  // do usuário que o número da planilha foi descartado.
  // gmvOficial é o que ficou GRAVADO — é ele que a comissão tem que usar, não o da planilha,
  // senão a comissão passaria a divergir do GMV que a tela mostra.
  const linha = updated.rows[0]
  return {
    gmvPreservado: Boolean(linha?.gmv_preservado),
    gmvOficial: linha?.ads_gmv == null ? null : Number(linha.ads_gmv),
  }
}


function rowsDateRange(rows) {
  const dates = rows.map((r) => r.normalized.live_date).filter(Boolean).sort()
  if (dates.length === 0) return null
  return { fromDate: dates[0], toDate: dates[dates.length - 1] }
}

// Grava o lote e suas linhas. Serve os dois caminhos de entrada — a tela, que
// deixa tudo pendente para alguém revisar, e a automação, que já chega com a
// decisão tomada. Quem manda na decisão é `decisaoDe`, e é a única diferença
// entre os dois.
async function criarLoteDeImportacao(db, {
  tenantId, sub, upload, sourceType, matchedRows, summary,
  marcaId, apresentadoraId, fileHash = null, decisaoDe,
}) {
  const batchQ = await db.query(
    `INSERT INTO analytics_import_batches (
       tenant_id, filename, source_type, marca_id, apresentadora_id,
       total_rows, matched_rows, ambiguous_rows,
       unmatched_rows, skipped_rows, invalid_rows, summary, created_by, file_hash
     )
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
     RETURNING id`,
    [
      tenantId,
      upload.filename,
      sourceType,
      marcaId,
      apresentadoraId,
      summary.total_rows,
      summary.matched_rows,
      summary.ambiguous_rows,
      summary.unmatched_rows,
      summary.skipped_rows,
      summary.invalid_rows,
      JSON.stringify(summary),
      sub ?? null,
      fileHash,
    ],
  )
  const batchId = batchQ.rows[0].id

  const defaultApresentadoras = apresentadoraId
    ? JSON.stringify([{ apresentadora_id: apresentadoraId, percentual: 100 }])
    : null

  const rowIds = new Map()
  const decisoes = new Map()
  for (const row of matchedRows) {
    const decisao = decisaoDe(row)
    const inserted = await db.query(
      `INSERT INTO analytics_import_rows (
         tenant_id, batch_id, row_index, raw, normalized,
         marca_nome, live_date, start_time, duration_seconds,
         matched_live_id, matched_agenda_evento_id,
         match_status, match_confidence, match_reason, candidates,
         decisao, marca_id, apresentadoras
       )
       VALUES (
         $1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb,
         $6, $7::date, $8, $9,
         $10::uuid, $11::uuid,
         $12, $13, $14, $15::jsonb,
         $16, $17::uuid, $18::jsonb
       )
       RETURNING id`,
      [
        tenantId,
        batchId,
        row.row_index,
        JSON.stringify(row.raw),
        JSON.stringify(row.normalized),
        row.normalized.marca_nome,
        row.normalized.live_date,
        row.normalized.start_time,
        row.normalized.duration_seconds,
        row.matched_live_id ?? null,
        row.matched_agenda_evento_id ?? null,
        row.match_status,
        row.match_confidence ?? null,
        row.match_reason ?? null,
        JSON.stringify(row.candidates ?? []),
        decisao,
        marcaId,
        defaultApresentadoras,
      ],
    )
    // A tela de revisão precisa do id da linha para editar decisão e rateio.
    rowIds.set(row.row_index, inserted.rows[0]?.id ?? null)
    decisoes.set(row.row_index, decisao)
  }

  return { batchId, rowIds, decisoes }
}

/** Erro com código HTTP, para o handler traduzir sem adivinhar pela mensagem. */
class ErroDeImportacao extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

// Aplica um lote já revisado: resolve a live de cada linha, grava métricas,
// rateio e comissão, e roda o retro-lift do mês uma vez por (apresentadora,
// mês). Espera uma transação já aberta e devolve o resumo — quem chama decide
// o COMMIT.
//
// Vive aqui fora, e não dentro do handler, porque dois caminhos aplicam lote: a
// tela (POST /:id/apply) e a automação (POST /ingest). Duas cópias deste laço
// seriam dois escritores no caminho do dinheiro, que é como uma delas fica para
// trás sem ninguém notar.
async function aplicarLoteDeImportacao(db, { tenantId, batchId, sub }) {
  const batchQ = await db.query(
    `SELECT id, status, source_type, marca_id, apresentadora_id
       FROM analytics_import_batches
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
      FOR UPDATE`,
    [batchId, tenantId],
  )
  const batch = batchQ.rows[0]
  if (!batch) throw new ErroDeImportacao(404, 'Importacao nao encontrada')
  if (batch.status === 'applied') throw new ErroDeImportacao(409, 'Importacao ja aplicada')

  const rowsQ = await db.query(
    `SELECT id, row_index, matched_live_id, normalized, decisao, marca_id, apresentadoras, cabine_id
       FROM analytics_import_rows
      WHERE tenant_id = $1::uuid
        AND batch_id = $2::uuid
        AND decisao IN ('vincular', 'criar')
        AND applied_at IS NULL
      ORDER BY row_index ASC
      FOR UPDATE`,
    [tenantId, batchId],
  )

  // Só vale o custo de adivinhar quando sobrou alguma linha 'criar' sem cabine confirmada.
  const cabinePadraoId = rowsQ.rows.some((row) => row.decisao === 'criar' && !row.cabine_id)
    ? await resolveCabinePadrao(db, tenantId, batch.marca_id)
    : null

  let applied = 0
  // Lives cujo GMV corrigido à mão prevaleceu sobre o da planilha (ver applyMetricsToLive).
  let gmvsPreservados = 0
  const failures = []
  const touchedLiveIds = []
  // Guarda final contra duas linhas gravando na mesma live (a segunda apagaria a
  // primeira). O matcher e o PATCH já barram antes; aqui é a rede de segurança.
  const livesDoLote = new Map()
  // (apresentadora, mês) tocados pelo lote — o retro-lift do cliff roda uma vez
  // por par no fim, em vez de uma vez por linha. Map dedupe pela chave.
  const retroLiftPendente = new Map()

  for (const row of rowsQ.rows) {
    const n = row.normalized ?? {}
    await db.query('SAVEPOINT import_row')
    try {
      const liveId = await resolveTargetLive(db, {
        tenantId,
        row,
        normalized: n,
        batch,
        cabinePadraoId,
      })

      if (livesDoLote.has(liveId)) {
        throw new Error(`Live já recebeu a linha ${livesDoLote.get(liveId)} deste arquivo`)
      }
      livesDoLote.set(liveId, row.row_index)

      const { gmvPreservado, gmvOficial } = await applyMetricsToLive(db, {
        tenantId,
        liveId,
        normalized: n,
        batchId,
        rowId: row.id,
      })
      if (gmvPreservado) gmvsPreservados += 1
      await applyApresentadorasToLive(db, {
        tenantId,
        liveId,
        apresentadoras: row.apresentadoras,
        duracaoPlanilha: n.duration_seconds ?? null,
      })

      const gmv = gmvPreservado ? gmvOficial : officialGmvOf(n)
      if (gmv != null) {
        // retroLift: false — o recálculo do mês inteiro sai daqui e roda UMA vez
        // por (apresentadora, mês) depois do laço. Rodando por linha, cada uma
        // refazia o mês que a anterior acabou de refazer: 9 linhas custavam 177s.
        const vendas = await calcularComissoesDaLive(db, {
          liveId,
          tenantId,
          gmv,
          pedidos: n.attributed_orders ?? 0,
          retroLift: false,
        })
        for (const venda of Array.isArray(vendas) ? vendas : []) {
          const apId = venda?.apresentadora_id
          if (!apId) continue
          const mes = typeof venda.data === 'string' ? venda.data.slice(0, 7) : null
          retroLiftPendente.set(`${apId}|${mes ?? ''}`, { apresentadoraId: apId, mes })
        }
      }

      await db.query(
        `UPDATE analytics_import_rows
            SET applied_at = NOW(), error = NULL, matched_live_id = $3::uuid
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [row.id, tenantId, liveId],
      )
      await db.query('RELEASE SAVEPOINT import_row')
      touchedLiveIds.push(liveId)
      applied++
    } catch (err) {
      // Uma linha ruim não pode derrubar o lote inteiro: volta ao savepoint e registra o erro.
      await db.query('ROLLBACK TO SAVEPOINT import_row')
      await db.query(
        `UPDATE analytics_import_rows SET error = $3
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [row.id, tenantId, String(err.message).slice(0, 500)],
      )
      failures.push({ row_index: row.row_index, error: err.message })
    }
  }

  // Retro-lift do cliff, adiado: a escada usa o GMV MENSAL acumulado, então as vendas
  // gravadas agora podem ter empurrado a apresentadora para uma faixa maior. Rodando
  // aqui, uma vez por (apresentadora, mês), o resultado é o mesmo que rodar a cada
  // linha — só a última passada sobrevivia — por uma fração das idas ao banco.
  // Ainda dentro da transação: ou o lote inteiro vale, ou nada vale.
  for (const { apresentadoraId, mes } of retroLiftPendente.values()) {
    await aplicarRetroLiftDoMes(db, { tenantId, apresentadoraId, mes })
  }

  // Só fecha o lote se tudo passou. Com falhas ele continua reaplicável (as linhas que já
  // gravaram são puladas por applied_at), senão uma falha transitória travaria o retry.
  const tudoOk = failures.length === 0
  await db.query(
    `UPDATE analytics_import_batches
        SET status = CASE WHEN $5::boolean THEN 'applied' ELSE status END,
            applied_rows = COALESCE(applied_rows, 0) + $1,
            applied_by = $2,
            applied_at = CASE WHEN $5::boolean THEN NOW() ELSE applied_at END
      WHERE id = $3::uuid
        AND tenant_id = $4::uuid`,
    [applied, sub ?? null, batchId, tenantId, tudoOk],
  )

  return { applied, failures, gmvsPreservados, touchedLiveIds }
}

export async function analyticsRoutes(app) {
  app.post('/v1/analytics/imports/preview', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { tenant_id, sub } = request.user
    try {
      const upload = await readAnalyticsImportUpload(request)
      const { source_type: sourceType, rows: parsedRows } = parseAnalyticsImportBuffer(upload)
      if (parsedRows.length === 0) {
        return reply.code(400).send({ error: 'Arquivo sem linhas importaveis' })
      }
      if (parsedRows.length > MAX_IMPORT_ROWS) {
        return reply.code(400).send({ error: `Arquivo com ${parsedRows.length} linhas excede o limite de ${MAX_IMPORT_ROWS}` })
      }

      const marcaId = readUploadField(request, upload.fields, 'marca_id')
      const apresentadoraId = readUploadField(request, upload.fields, 'apresentadora_id')

      // O Creator Live Performance não traz a marca: sem ela não há como casar nem criar a live.
      if (sourceType === SOURCE_TIKTOK_STUDIO) {
        if (!marcaId || !UUID_RE.test(marcaId)) {
          return reply.code(400).send({ error: 'Selecione a marca antes de importar o relatorio do TikTok Studio' })
        }
        if (!apresentadoraId || !UUID_RE.test(apresentadoraId)) {
          return reply.code(400).send({ error: 'Selecione a apresentadora antes de importar o relatorio do TikTok Studio' })
        }
      }

      const range = rowsDateRange(parsedRows)
      if (!range) return reply.code(400).send({ error: 'Nenhuma linha com data valida encontrada' })

      return await app.withTenant(tenant_id, async (db) => {
        await db.query('BEGIN')
        try {
          if (marcaId) {
            const marcaQ = await db.query(
              'SELECT id FROM marcas WHERE id = $1::uuid AND tenant_id = $2::uuid',
              [marcaId, tenant_id],
            )
            if (marcaQ.rowCount === 0) {
              await db.query('ROLLBACK').catch(() => {})
              return reply.code(400).send({ error: 'Marca nao encontrada' })
            }
          }
          if (apresentadoraId) {
            const apreQ = await db.query(
              'SELECT id FROM apresentadoras WHERE id = $1::uuid AND tenant_id = $2::uuid',
              [apresentadoraId, tenant_id],
            )
            if (apreQ.rowCount === 0) {
              await db.query('ROLLBACK').catch(() => {})
              return reply.code(400).send({ error: 'Apresentadora nao encontrada' })
            }
          }

          const candidates = await loadAnalyticsImportCandidates(db, range)
          const matchedRows = matchAnalyticsImportRows(parsedRows, candidates, { marcaId })
          const summary = summarizeImportRows(matchedRows)

          const { batchId, rowIds } = await criarLoteDeImportacao(db, {
            tenantId: tenant_id,
            sub,
            upload,
            sourceType,
            matchedRows,
            summary,
            marcaId,
            apresentadoraId,
            decisaoDe: (row) => defaultDecisionFor(row.match_status),
          })

          await db.query('COMMIT')
          return {
            batch_id: batchId,
            filename: upload.filename,
            source_type: sourceType,
            marca_id: marcaId,
            apresentadora_id: apresentadoraId,
            summary,
            rows: matchedRows.map((row) => ({
              ...rowResponse({ ...row, id: rowIds.get(row.row_index) ?? null }),
              decisao: defaultDecisionFor(row.match_status),
              marca_id: marcaId,
              apresentadoras: apresentadoraId
                ? [{ apresentadora_id: apresentadoraId, percentual: 100 }]
                : [],
            })),
          }
        } catch (err) {
          await db.query('ROLLBACK').catch(() => {})
          throw err
        }
      })
    } catch (err) {
      request.log.error({ err }, 'analytics/imports/preview error')
      return reply.code(400).send({ error: err.message })
    }
  })

  // Entrada de máquina: recebe o arquivo, decide o que dá para decidir sozinho e
  // aplica na mesma chamada. O caminho da tela (preview → revisão → apply)
  // pressupõe alguém olhando entre uma etapa e outra; uma automação não tem esse
  // alguém.
  //
  // O que ela NÃO faz é decidir no lugar de quem sabe: linha ambígua ou de
  // casamento fraco fica pendente no mesmo lote de sempre, visível na tela de
  // importação. Número duvidoso aplicado em silêncio vira comissão errada, e
  // ninguém descobre olhando o dashboard.
  app.post('/v1/analytics/imports/ingest', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    // `sub` de uma chave é `apikey:<uuid>`, que não entra nas colunas UUID de
    // created_by/applied_by. O id da chave entra, e é o que identifica o autor.
    const sub = request.viaApiKey?.id ?? request.user.sub

    try {
      const upload = await readAnalyticsImportUpload(request)
      const fileHash = createHash('sha256').update(upload.buffer).digest('hex')

      const { source_type: sourceType, rows: parsedRows } = parseAnalyticsImportBuffer(upload)
      if (parsedRows.length === 0) {
        return reply.code(400).send({ error: 'Arquivo sem linhas importaveis' })
      }
      // Teto mais baixo que o da tela: aqui tudo acontece numa requisição só, e
      // o Railway corta antes de o lote terminar. Melhor pedir para fatiar do
      // que estourar no meio com metade do arquivo aplicada.
      if (parsedRows.length > MAX_INGEST_ROWS) {
        return reply.code(413).send({
          error: `Arquivo com ${parsedRows.length} linhas excede o limite de ${MAX_INGEST_ROWS} desta rota. Divida o arquivo e envie em partes.`,
        })
      }

      const marcaId = readUploadField(request, upload.fields, 'marca_id')
      const apresentadoraId = readUploadField(request, upload.fields, 'apresentadora_id')
      const criarLives = String(readUploadField(request, upload.fields, 'criar_lives') ?? '')
        .toLowerCase() === 'true'

      if (sourceType === SOURCE_TIKTOK_STUDIO) {
        if (!marcaId || !UUID_RE.test(marcaId)) {
          return reply.code(400).send({ error: 'Informe marca_id para o relatorio do TikTok Studio' })
        }
        if (!apresentadoraId || !UUID_RE.test(apresentadoraId)) {
          return reply.code(400).send({ error: 'Informe apresentadora_id para o relatorio do TikTok Studio' })
        }
      }

      const range = rowsDateRange(parsedRows)
      if (!range) return reply.code(400).send({ error: 'Nenhuma linha com data valida encontrada' })

      return await app.withTenant(tenant_id, async (db) => {
        await db.query('BEGIN')
        try {
          // Reenvio do mesmo arquivo é a falha mais provável de um agente: ele
          // não entende a resposta e tenta de novo. Sem isto, o segundo envio
          // dobrava o GMV do mês.
          const jaVisto = await db.query(
            `SELECT id, applied_rows FROM analytics_import_batches
              WHERE tenant_id = $1::uuid
                AND file_hash = $2
                AND status = 'applied'
                AND created_at > NOW() - INTERVAL '24 hours'
              ORDER BY created_at DESC
              LIMIT 1`,
            [tenant_id, fileHash],
          )
          if (jaVisto.rowCount > 0) {
            await db.query('COMMIT')
            return {
              ok: true,
              duplicado: true,
              batch_id: jaVisto.rows[0].id,
              applied_rows: jaVisto.rows[0].applied_rows ?? 0,
              // Resposta com a mesma forma da original de propósito: o agente
              // não tem por que insistir.
              pendentes: [],
            }
          }

          if (marcaId) {
            const marcaQ = await db.query(
              'SELECT id FROM marcas WHERE id = $1::uuid AND tenant_id = $2::uuid',
              [marcaId, tenant_id],
            )
            if (marcaQ.rowCount === 0) {
              await db.query('ROLLBACK').catch(() => {})
              return reply.code(400).send({ error: 'Marca nao encontrada' })
            }
          }
          if (apresentadoraId) {
            const apreQ = await db.query(
              'SELECT id FROM apresentadoras WHERE id = $1::uuid AND tenant_id = $2::uuid',
              [apresentadoraId, tenant_id],
            )
            if (apreQ.rowCount === 0) {
              await db.query('ROLLBACK').catch(() => {})
              return reply.code(400).send({ error: 'Apresentadora nao encontrada' })
            }
          }

          const candidates = await loadAnalyticsImportCandidates(db, range)
          const matchedRows = matchAnalyticsImportRows(parsedRows, candidates, { marcaId })
          const summary = summarizeImportRows(matchedRows)

          const { batchId, decisoes } = await criarLoteDeImportacao(db, {
            tenantId: tenant_id,
            sub,
            upload,
            sourceType,
            matchedRows,
            summary,
            marcaId,
            apresentadoraId,
            fileHash,
            decisaoDe: (row) => decisaoAutomatica(row, { criarLives }),
          })

          const resultado = await aplicarLoteDeImportacao(db, {
            tenantId: tenant_id,
            batchId,
            sub,
          })

          await db.query('COMMIT')

          invalidateTenant(tenant_id)
          invalidateHomeDashboard(tenant_id)

          // O que ficou de fora vai nomeado na resposta: é o trabalho de revisão
          // que sobra para a tela, e o agente precisa poder dizer isso a quem
          // perguntar.
          const pendentes = matchedRows
            .filter((row) => decisoes.get(row.row_index) === 'pendente')
            .map((row) => ({
              row_index: row.row_index,
              marca: row.normalized?.marca_nome ?? null,
              data: row.normalized?.live_date ?? null,
              motivo: row.match_reason ?? row.match_status,
            }))

          app.audit?.log?.(request, {
            action: 'analytics.import_ingest',
            entity_type: 'analytics_import_batch',
            entity_id: batchId,
            metadata: {
              applied_rows: resultado.applied,
              pendentes: pendentes.length,
              failed_rows: resultado.failures.length,
              gmv_preservado_rows: resultado.gmvsPreservados,
            },
          })?.catch?.((err) => app.log.error({ err }, 'audit import_ingest falhou'))

          return {
            ok: true,
            duplicado: false,
            batch_id: batchId,
            total_rows: summary.total_rows,
            applied_rows: resultado.applied,
            gmv_preservado_rows: resultado.gmvsPreservados,
            failed_rows: resultado.failures,
            pendentes,
          }
        } catch (err) {
          await db.query('ROLLBACK').catch(() => {})
          throw err
        }
      })
    } catch (err) {
      request.log.error({ err }, 'analytics/imports/ingest error')
      const code = err instanceof ErroDeImportacao ? err.statusCode : 400
      return reply.code(code).send({ error: err.message })
    }
  })

  app.get('/v1/analytics/imports', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request) => {
    const { tenant_id } = request.user
    const limit = Math.min(Number(request.query?.limit ?? 20) || 20, 100)
    return app.withTenant(tenant_id, async (db) => {
      const q = await db.query(
        `SELECT b.id, b.filename, b.source_type, b.status, b.marca_id, b.apresentadora_id,
                m.nome AS marca_nome,
                b.total_rows, b.matched_rows, b.ambiguous_rows, b.unmatched_rows,
                b.skipped_rows, b.invalid_rows, b.applied_rows, b.created_at, b.applied_at
           FROM analytics_import_batches b
           LEFT JOIN marcas m ON m.id = b.marca_id AND m.tenant_id = b.tenant_id
          WHERE b.tenant_id = $1::uuid
          ORDER BY b.created_at DESC
          LIMIT $2`,
        [tenant_id, limit],
      )
      return q.rows
    })
  })

  app.get('/v1/analytics/imports/:id', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const batchId = request.params.id
    if (!UUID_RE.test(batchId)) return reply.code(400).send({ error: 'id must be a valid UUID' })

    return app.withTenant(tenant_id, async (db) => {
      const batchQ = await db.query(
        `SELECT b.*, m.nome AS marca_nome, a.nome AS apresentadora_nome
           FROM analytics_import_batches b
           LEFT JOIN marcas m ON m.id = b.marca_id AND m.tenant_id = b.tenant_id
           LEFT JOIN apresentadoras a ON a.id = b.apresentadora_id AND a.tenant_id = b.tenant_id
          WHERE b.id = $1::uuid AND b.tenant_id = $2::uuid`,
        [batchId, tenant_id],
      )
      const batch = batchQ.rows[0]
      if (!batch) return reply.code(404).send({ error: 'Importacao nao encontrada' })

      const rowsQ = await db.query(
        `SELECT id, row_index, normalized, marca_nome, live_date, start_time, duration_seconds,
                matched_live_id, matched_agenda_evento_id, match_status, match_confidence,
                match_reason, candidates, decisao, marca_id, cabine_id, apresentadoras,
                applied_at, error
           FROM analytics_import_rows
          WHERE batch_id = $1::uuid AND tenant_id = $2::uuid
          ORDER BY row_index ASC`,
        [batchId, tenant_id],
      )

      return {
        batch_id: batch.id,
        filename: batch.filename,
        source_type: batch.source_type,
        status: batch.status,
        marca_id: batch.marca_id,
        marca_nome: batch.marca_nome,
        apresentadora_id: batch.apresentadora_id,
        apresentadora_nome: batch.apresentadora_nome,
        summary: batch.summary,
        rows: rowsQ.rows.map((row) => ({
          ...rowResponse(row),
          decisao: row.decisao,
          marca_id: row.marca_id,
          cabine_id: row.cabine_id,
          apresentadoras: row.apresentadoras ?? [],
          applied_at: row.applied_at,
        })),
      }
    })
  })

  app.patch('/v1/analytics/imports/:id/rows/:rowId', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { id: batchId, rowId } = request.params
    if (!UUID_RE.test(batchId) || !UUID_RE.test(rowId)) {
      return reply.code(400).send({ error: 'id must be a valid UUID' })
    }

    const parsed = importRowPatchSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'payload invalido' })
    }
    const patch = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      const batchQ = await db.query(
        'SELECT status FROM analytics_import_batches WHERE id = $1::uuid AND tenant_id = $2::uuid',
        [batchId, tenant_id],
      )
      if (batchQ.rowCount === 0) return reply.code(404).send({ error: 'Importacao nao encontrada' })
      if (batchQ.rows[0].status === 'applied') {
        return reply.code(409).send({ error: 'Importacao ja aplicada' })
      }

      // A role do Supabase tem BYPASSRLS e as FKs são só por id: sem esta checagem, um tenant
      // conseguiria apontar a live para a marca/apresentadora de outro.
      if (patch.marca_id) {
        const q = await db.query(
          'SELECT 1 FROM marcas WHERE id = $1::uuid AND tenant_id = $2::uuid',
          [patch.marca_id, tenant_id],
        )
        if (q.rowCount === 0) return reply.code(400).send({ error: 'Marca nao encontrada' })
      }
      if (patch.cabine_id) {
        const q = await db.query(
          `SELECT 1 FROM cabines
            WHERE id = $1::uuid AND tenant_id = $2::uuid
              AND COALESCE(ativo, true) AND deleted_at IS NULL`,
          [patch.cabine_id, tenant_id],
        )
        if (q.rowCount === 0) return reply.code(400).send({ error: 'Cabine nao encontrada' })
      }
      if (patch.matched_live_id) {
        const q = await db.query(
          'SELECT 1 FROM lives WHERE id = $1::uuid AND tenant_id = $2::uuid',
          [patch.matched_live_id, tenant_id],
        )
        if (q.rowCount === 0) return reply.code(400).send({ error: 'Live nao encontrada' })
      }
      if (patch.apresentadoras?.length) {
        const ids = patch.apresentadoras.map((item) => item.apresentadora_id)
        const q = await db.query(
          'SELECT id FROM apresentadoras WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid',
          [ids, tenant_id],
        )
        if (q.rowCount !== ids.length) {
          return reply.code(400).send({ error: 'Apresentadora nao encontrada' })
        }
      }

      // As duas checagens abaixo valem sobre o estado FINAL da linha, não sobre o payload.
      // Antes, a trava de duplicidade só rodava quando matched_live_id vinha no PATCH: mandar
      // apenas { decisao: 'vincular' } passava direto, e duas linhas terminavam apontando para a
      // mesma live — no apply a primeira gravava GMV e comissão nela e a segunda falhava.
      const atualQ = await db.query(
        'SELECT matched_live_id, decisao FROM analytics_import_rows WHERE id = $1::uuid AND tenant_id = $2::uuid',
        [rowId, tenant_id],
      )
      if (atualQ.rowCount === 0) return reply.code(404).send({ error: 'Linha nao encontrada' })
      const liveFinal = patch.matched_live_id !== undefined
        ? patch.matched_live_id
        : atualQ.rows[0].matched_live_id
      const decisaoFinal = patch.decisao ?? atualQ.rows[0].decisao

      if (decisaoFinal === 'vincular' && !liveFinal) {
        return reply.code(400).send({ error: 'Escolha a live antes de marcar a linha como vincular' })
      }

      if (decisaoFinal === 'vincular' && liveFinal) {
        const jaUsada = await db.query(
          `SELECT row_index FROM analytics_import_rows
            WHERE tenant_id = $1::uuid AND batch_id = $2::uuid
              AND matched_live_id = $3::uuid AND id <> $4::uuid
              AND decisao = 'vincular'
            LIMIT 1`,
          [tenant_id, batchId, liveFinal, rowId],
        )
        if (jaUsada.rowCount > 0) {
          return reply.code(409).send({
            error: `Essa live já está vinculada à linha ${jaUsada.rows[0].row_index} deste arquivo`,
          })
        }
      }

      const updated = await db.query(
        `UPDATE analytics_import_rows
            SET decisao = COALESCE($3, decisao),
                marca_id = COALESCE($4::uuid, marca_id),
                matched_live_id = CASE WHEN $5::boolean THEN $6::uuid ELSE matched_live_id END,
                apresentadoras = COALESCE($7::jsonb, apresentadoras),
                cabine_id = CASE WHEN $9::boolean THEN $10::uuid ELSE cabine_id END
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND batch_id = $8::uuid
          RETURNING id, row_index, normalized, marca_nome, live_date, start_time, duration_seconds,
                    matched_live_id, match_status, match_confidence, match_reason, candidates,
                    decisao, marca_id, apresentadoras, cabine_id, error`,
        [
          rowId,
          tenant_id,
          patch.decisao ?? null,
          patch.marca_id ?? null,
          patch.matched_live_id !== undefined,
          patch.matched_live_id ?? null,
          patch.apresentadoras ? JSON.stringify(patch.apresentadoras) : null,
          batchId,
          patch.cabine_id !== undefined,
          patch.cabine_id ?? null,
        ],
      )
      const row = updated.rows[0]
      if (!row) return reply.code(404).send({ error: 'Linha nao encontrada' })

      return {
        ...rowResponse(row),
        decisao: row.decisao,
        marca_id: row.marca_id,
        cabine_id: row.cabine_id,
        apresentadoras: row.apresentadoras ?? [],
      }
    })
  })

  app.delete('/v1/analytics/imports/:id', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const batchId = request.params.id
    if (!UUID_RE.test(batchId)) return reply.code(400).send({ error: 'id must be a valid UUID' })

    return app.withTenant(tenant_id, async (db) => {
      const q = await db.query(
        `UPDATE analytics_import_batches
            SET status = 'cancelled'
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'applied'
          RETURNING id`,
        [batchId, tenant_id],
      )
      if (q.rowCount === 0) {
        return reply.code(409).send({ error: 'Importacao ja aplicada ou nao encontrada' })
      }
      app.audit?.log?.(request, { action: 'analytics.import_cancel', entity_type: 'analytics_import_batch', entity_id: batchId })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return { ok: true, batch_id: batchId, status: 'cancelled' }
    })
  })

  app.post('/v1/analytics/imports/:id/apply', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { tenant_id, sub } = request.user
    const batchId = request.params.id
    if (!UUID_RE.test(batchId)) return reply.code(400).send({ error: 'id must be a valid UUID' })

    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const { applied, failures, gmvsPreservados, touchedLiveIds } =
          await aplicarLoteDeImportacao(db, { tenantId: tenant_id, batchId, sub })

        await db.query('COMMIT')

        // O import reescreve GMV, métricas e comissão das lives. Sem isto os painéis continuam
        // servindo o valor anterior até o TTL vencer, e o usuário vê a home "atrasada" em
        // relação ao Analytics logo depois de importar.
        invalidateTenant(tenant_id)
        invalidateHomeDashboard(tenant_id)

        app.audit?.log?.(request, { action: 'analytics.import_apply', entity_type: 'analytics_import_batch', entity_id: batchId, metadata: { applied_rows: applied, failed_rows: failures.length, gmv_preservado_rows: gmvsPreservados, live_ids: touchedLiveIds } })?.catch(err => app.log.error({ err }, 'audit log failed'))
        return { ok: true, batch_id: batchId, applied_rows: applied, failed_rows: failures, gmv_preservado_rows: gmvsPreservados }
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        if (err instanceof ErroDeImportacao) return reply.code(err.statusCode).send({ error: err.message })
        request.log.error({ err }, 'analytics/imports/apply error')
        return reply.code(500).send({ error: err.message })
      }
    })
  })

  app.get('/v1/analytics/franqueado/resumo', {
    preHandler: [
      app.authenticate,
      app.requirePapel(READ_ANALYTICS),
    ],
  }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const [
        resumoHojeQ,
        rankingClosersQ,
        rankingClientesQ,
        heatmapHorariosQ,
        eficienciaCabinesQ,
      ] = await Promise.all([
        // Defesa em profundidade: filtros tenant_id explícitos via current_setting.
        // Role Postgres do Supabase tem BYPASSRLS, então RLS sozinha não basta.
        db.query(`
        WITH lives_ao_vivo AS (
          SELECT c.live_atual_id AS live_id
          FROM cabines c
          WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND c.status = 'ao_vivo'
            AND c.live_atual_id IS NOT NULL
        ), snapshots_recentes AS (
          SELECT DISTINCT ON (ls.live_id)
                 ls.live_id,
                 ls.viewer_count,
                 ls.gmv
          FROM live_snapshots ls
          JOIN lives_ao_vivo laov ON laov.live_id = ls.live_id
          WHERE ls.tenant_id = current_setting('app.tenant_id', true)::uuid
          ORDER BY ls.live_id, ls.captured_at DESC
        )
        SELECT
          COALESCE(SUM(sr.gmv), 0) AS gmv_total_hoje,
          COALESCE(SUM(sr.viewer_count), 0) AS audiencia_total_ao_vivo,
          (
            SELECT COUNT(*)
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              AND date_trunc('day', l.iniciado_em) = date_trunc('day', NOW())
          ) AS total_lives_hoje
        FROM snapshots_recentes sr
      `),
        db.query(`
        SELECT
          u.id AS apresentador_id,
          u.nome AS apresentador_nome,
          COUNT(l.id) AS total_lives,
          COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_total
        FROM lives l
        JOIN users u ON u.id = l.apresentador_id
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
        GROUP BY u.id, u.nome
        ORDER BY gmv_total DESC, total_lives DESC, apresentador_nome ASC
        LIMIT 5
      `),
        db.query(`
        SELECT
          c.id AS cliente_id,
          c.nome AS cliente_nome,
          COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_total,
          MAX(l.iniciado_em) AS ultima_live
        FROM lives l
        JOIN clientes c ON c.id = l.cliente_id AND c.tenant_id = l.tenant_id
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
        GROUP BY c.id, c.nome
        ORDER BY gmv_total DESC, ultima_live DESC NULLS LAST, cliente_nome ASC
        LIMIT 5
      `),
        db.query(`
        SELECT
          EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
          COUNT(*) AS total_lives,
          COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_total
        FROM lives l
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
        GROUP BY 1
        ORDER BY 1 ASC
      `),
        db.query(`
        SELECT
          c.id AS cabine_id,
          CONCAT('Cabine ', LPAD(c.numero::text, 2, '0')) AS cabine_nome,
          COUNT(l.id) AS total_lives,
          COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_acumulado
        FROM cabines c
        LEFT JOIN lives l
          ON l.cabine_id = c.id
         AND l.tenant_id = c.tenant_id
         AND l.status = 'encerrada'
        WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
        GROUP BY c.id, c.numero
        ORDER BY gmv_acumulado DESC, total_lives DESC, c.numero ASC
        LIMIT 5
      `),
      ])

      const resumoHoje = resumoHojeQ.rows[0] ?? {}

      return {
        resumo_hoje: {
          gmv_total_hoje: parseFloat(Number(resumoHoje.gmv_total_hoje ?? 0).toFixed(2)),
          audiencia_total_ao_vivo: Number(resumoHoje.audiencia_total_ao_vivo ?? 0),
          total_lives_hoje: Number(resumoHoje.total_lives_hoje ?? 0),
        },
        ranking_closers: rankingClosersQ.rows.map((row) => ({
          apresentador_id: row.apresentador_id,
          apresentador_nome: row.apresentador_nome,
          total_lives: Number(row.total_lives),
          gmv_total: parseFloat(Number(row.gmv_total).toFixed(2)),
        })),
        ranking_clientes: rankingClientesQ.rows.map((row) => ({
          cliente_id: row.cliente_id,
          cliente_nome: row.cliente_nome,
          gmv_total: parseFloat(Number(row.gmv_total).toFixed(2)),
          ultima_live: row.ultima_live,
        })),
        heatmap_horarios: heatmapHorariosQ.rows.map((row) => ({
          hora: Number(row.hora),
          total_lives: Number(row.total_lives),
          gmv_total: parseFloat(Number(row.gmv_total).toFixed(2)),
        })),
        eficiencia_cabines: eficienciaCabinesQ.rows.map((row) => ({
          cabine_id: row.cabine_id,
          cabine_nome: row.cabine_nome,
          total_lives: Number(row.total_lives),
          gmv_acumulado: parseFloat(Number(row.gmv_acumulado).toFixed(2)),
        })),
      }
    })
  })

  app.get('/v1/analytics/dashboard', {
    preHandler: [
      app.authenticate,
      app.requirePapel(READ_ANALYTICS),
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          cliente_id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          mesAno: { type: 'string' },
          mes: { type: 'string' },
          ano: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { cliente_id } = request.query

    if (cliente_id && !UUID_RE.test(cliente_id)) {
      return reply.code(400).send({ error: 'cliente_id must be a valid UUID' })
    }

    const period = resolveAnalyticsPeriod(request.query)
    if (period.error) return reply.code(400).send({ error: period.error })

    const { fromDate, toDate, mesAno } = period
    const days = Math.floor((new Date(`${toDate}T00:00:00.000Z`) - new Date(`${fromDate}T00:00:00.000Z`)) / 86400000) + 1
    const prevTo = addDays(fromDate, -1)
    const prevFrom = addDays(prevTo, -days + 1)

    const params = cliente_id ? [fromDate, toDate, cliente_id] : [fromDate, toDate]
    const prevParams = cliente_id ? [prevFrom, prevTo, cliente_id] : [prevFrom, prevTo]

    const startedAt = performance.now()
    const cacheKey = buildCacheKey(tenant_id, { from: fromDate, to: toDate, cliente_id: cliente_id ?? null })

    try {
      const { value, state } = await withCache({
        namespace: 'analytics:dashboard',
        key: cacheKey,
        ttlMs: ANALYTICS_DASHBOARD_CACHE_TTL_MS,
        computeFn: () => app.withTenant(tenant_id, async (db) => {
        const rankingRange = { start: fromDate, end: addDays(toDate, 1), mes: mesAno }
        const clienteSalesJoin = cliente_id
          ? 'JOIN marcas m_cliente ON m_cliente.id = va.marca_id AND m_cliente.tenant_id = va.tenant_id AND m_cliente.cliente_id = $3::uuid'
          : ''
        const clienteMarcaFilter = cliente_id ? 'AND m.cliente_id = $3::uuid' : ''
        const clienteLiveFilter = cliente_id ? 'AND l.cliente_id = $3::uuid' : ''
        const clienteVideoJoin = cliente_id
          ? 'JOIN marcas m ON m.id = vr.marca_id AND m.tenant_id = vr.tenant_id AND m.cliente_id = $3::uuid'
          : ''

        const salesWhere = `
          va.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND va.origem IN ('live', 'video')
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
          AND va.data >= $1::date
          AND va.data <= $2::date
        `
        // Sargável: range cru no timestamptz com semântica de dia em São Paulo
        // IDÊNTICA ao cast ::date (dia inclusivo). Upper bound = dia seguinte
        // (exclusivo) para preservar a inclusão de $2. Usa o índice btree em
        // lives(tenant_id, status, iniciado_em) em vez de seq scan.
        const liveRange = `
          AND l.iniciado_em >= ($1::date) AT TIME ZONE '${ANALYTICS_TZ}'
          AND l.iniciado_em < (($2::date) + 1) AT TIME ZONE '${ANALYTICS_TZ}'
        `
        const videoRange = `
          AND vr.data >= $1::date
          AND vr.data <= $2::date
        `

        const [
          salesCurQ,
          salesPrevQ,
          liveOpsQ,
          videoOpsQ,
          monthlyQ,
          hoursQ,
          presenterRankingQ,
          brandRankingQ,
          peakHoursQ,
          heatmapQ,
        ] = await Promise.all([
          db.query(`
            WITH live_sales AS (
              SELECT
                COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_lives,
                COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos_lives
              FROM lives l
              WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND l.status = 'encerrada'
                ${liveRange}
                ${clienteLiveFilter}
            ),
            video_sales AS (
              SELECT
                COALESCE(SUM(va.gmv), 0) AS gmv_videos,
                COALESCE(SUM(va.pedidos), 0)::int AS pedidos_videos
              FROM vendas_atribuidas va
              ${clienteSalesJoin}
              WHERE ${salesWhere}
                AND va.origem = 'video'
            )
            SELECT
              (ls.gmv_lives + vs.gmv_videos) AS gmv_total,
              ls.gmv_lives,
              vs.gmv_videos,
              (ls.pedidos_lives + vs.pedidos_videos)::int AS pedidos_total,
              ls.pedidos_lives,
              vs.pedidos_videos
            FROM live_sales ls CROSS JOIN video_sales vs
          `, params),

          db.query(`
            WITH live_sales AS (
              SELECT
                COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_lives,
                COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos_lives
              FROM lives l
              WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND l.status = 'encerrada'
                AND l.iniciado_em >= ($1::date) AT TIME ZONE '${ANALYTICS_TZ}'
                AND l.iniciado_em < (($2::date) + 1) AT TIME ZONE '${ANALYTICS_TZ}'
                ${clienteLiveFilter}
            ),
            video_sales AS (
              SELECT
                COALESCE(SUM(va.gmv), 0) AS gmv_videos,
                COALESCE(SUM(va.pedidos), 0)::int AS pedidos_videos
              FROM vendas_atribuidas va
              ${clienteSalesJoin}
              WHERE ${salesWhere}
                AND va.origem = 'video'
            )
            SELECT
              (ls.gmv_lives + vs.gmv_videos) AS gmv_total,
              (ls.pedidos_lives + vs.pedidos_videos)::int AS pedidos_total
            FROM live_sales ls CROSS JOIN video_sales vs
          `, prevParams),

          db.query(`
            SELECT
              COUNT(*)::int AS total_lives,
              COALESCE(SUM(
                CASE
                  WHEN COALESCE(l.encerrado_em, l.previsto_fim) IS NOT NULL
                   AND COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
                    THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
                  ELSE 0
                END
              ), 0) AS horas_live,
              COALESCE(SUM(COALESCE(l.final_peak_viewers, l.manual_views, 0)), 0)::bigint AS viewers_total,
              COALESCE(SUM(COALESCE(l.final_total_likes, l.manual_likes, 0)), 0)::bigint AS likes_total,
              COALESCE(SUM(COALESCE(l.final_total_comments, l.manual_comments, 0)), 0)::bigint AS comentarios_total,
              COALESCE(SUM(COALESCE(l.final_total_shares, l.manual_shares, 0)), 0)::bigint AS shares_total,
              COALESCE(SUM(COALESCE(l.final_gifts_diamonds, l.manual_diamonds, 0)), 0)::bigint AS diamonds_total,
              -- % de likes vem do TikTok Studio: usa espectadores únicos como denominador, que
              -- não vem na planilha, então não dá para recalcular a partir de likes/views.
              ROUND(AVG(NULLIF((l.studio_metrics->>'like_rate')::numeric, 0)), 2) AS like_rate_medio,
              COALESCE(SUM(COALESCE(l.new_followers, 0)), 0)::bigint AS novos_seguidores
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              ${liveRange}
              ${clienteLiveFilter}
          `, params),

          db.query(`
            SELECT
              COUNT(*)::int AS registros_video,
              COALESCE(SUM(vr.quantidade), 0)::int AS total_videos
            FROM video_registros vr
            ${clienteVideoJoin}
            WHERE vr.tenant_id = current_setting('app.tenant_id', true)::uuid
              ${videoRange}
          `, params),

          db.query(`
            -- $1 (fromDate) é compartilhado com as outras queries do Promise.all
            -- mas esta CTE só usa $2 (toDate). Cast explícito abaixo força tipagem
            -- do parâmetro $1 — sem isso o Postgres lança "could not determine
            -- data type of parameter $1" porque $1 nunca aparece tipado na query.
            WITH typed_params AS (SELECT $1::date AS _from, $2::date AS _to),
            analytics_months AS (
              SELECT generate_series(
                date_trunc('month', $2::date) - interval '11 months',
                date_trunc('month', $2::date),
                interval '1 month'
              )::date AS mes_inicio
            ),
            live_sales AS (
              SELECT
                date_trunc('month', l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS mes_inicio,
                COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_lives,
                COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos_lives
              FROM lives l
              WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND l.status = 'encerrada'
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= (date_trunc('month', $2::date) - interval '11 months')::date
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date < (date_trunc('month', $2::date) + interval '1 month')::date
                ${clienteLiveFilter}
              GROUP BY 1
            ),
            video_sales AS (
              SELECT
                date_trunc('month', va.data)::date AS mes_inicio,
                COALESCE(SUM(va.gmv), 0) AS gmv_videos,
                COALESCE(SUM(va.pedidos), 0)::int AS pedidos_videos
              FROM vendas_atribuidas va
              ${clienteSalesJoin}
              WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND va.origem = 'video'
                AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
                AND va.data >= date_trunc('month', $2::date) - interval '11 months'
                AND va.data < date_trunc('month', $2::date) + interval '1 month'
              GROUP BY 1
            ),
            lives_ops AS (
              SELECT
                date_trunc('month', l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS mes_inicio,
                COUNT(*)::int AS total_lives
              FROM lives l
              WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND l.status = 'encerrada'
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= (date_trunc('month', $2::date) - interval '11 months')::date
                AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date < (date_trunc('month', $2::date) + interval '1 month')::date
                ${clienteLiveFilter}
              GROUP BY 1
            ),
            videos_ops AS (
              SELECT
                date_trunc('month', vr.data)::date AS mes_inicio,
                COALESCE(SUM(vr.quantidade), 0)::int AS total_videos
              FROM video_registros vr
              ${clienteVideoJoin}
              WHERE vr.tenant_id = current_setting('app.tenant_id', true)::uuid
                AND vr.data >= (date_trunc('month', $2::date) - interval '11 months')::date
                AND vr.data < (date_trunc('month', $2::date) + interval '1 month')::date
              GROUP BY 1
            )
            SELECT
              to_char(m.mes_inicio, 'YYYY-MM') AS mes,
              COALESCE(ls.gmv_lives, 0) + COALESCE(vs.gmv_videos, 0) AS gmv,
              COALESCE(ls.gmv_lives, 0) AS gmv_lives,
              COALESCE(vs.gmv_videos, 0) AS gmv_videos,
              (COALESCE(ls.pedidos_lives, 0) + COALESCE(vs.pedidos_videos, 0))::int AS pedidos,
              COALESCE(l.total_lives, 0)::int AS total_lives,
              COALESCE(v.total_videos, 0)::int AS total_videos
            FROM analytics_months m
            LEFT JOIN live_sales ls ON ls.mes_inicio = m.mes_inicio
            LEFT JOIN video_sales vs ON vs.mes_inicio = m.mes_inicio
            LEFT JOIN lives_ops l ON l.mes_inicio = m.mes_inicio
            LEFT JOIN videos_ops v ON v.mes_inicio = m.mes_inicio
            ORDER BY m.mes_inicio ASC
          `, params),

          db.query(`
            SELECT
              (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS dia,
              COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv_lives,
              COALESCE(SUM(COALESCE(l.manual_orders, l.final_orders_count, 0)), 0)::int AS pedidos_lives,
              COALESCE(SUM(
                CASE
                  WHEN COALESCE(l.encerrado_em, l.previsto_fim) IS NOT NULL
                   AND COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
                    THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
                  ELSE 0
                END
              ), 0) AS horas
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              ${liveRange}
              ${clienteLiveFilter}
            GROUP BY 1
            ORDER BY 1 ASC
          `, params),

          getPerformanceRanking(db, {
            tenantId: tenant_id,
            range: rankingRange,
            groupBy: 'apresentadora',
            limit: 10,
            clienteId: cliente_id ?? null,
          }),

          getPerformanceRanking(db, {
            tenantId: tenant_id,
            range: rankingRange,
            groupBy: 'marca',
            limit: 10,
            clienteId: cliente_id ?? null,
          }),

          db.query(`
            SELECT
              EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::int AS hora,
              COUNT(*)::int AS total_lives,
              COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              ${liveRange}
              ${clienteLiveFilter}
            GROUP BY 1
            ORDER BY 1 ASC
          `, params),

          db.query(`
            SELECT
              EXTRACT(ISODOW FROM l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::int AS dow,
              (FLOOR(EXTRACT(HOUR FROM l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}') / 3) * 3)::int AS bloco_hora,
              COUNT(*)::int AS lives,
              COALESCE(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)), 0) AS gmv
            FROM lives l
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              ${liveRange}
              ${clienteLiveFilter}
            GROUP BY 1, 2
            ORDER BY 1, 2
          `, params),
        ])

        const sales = salesCurQ.rows[0] ?? {}
        const prevSales = salesPrevQ.rows[0] ?? {}
        const liveOps = liveOpsQ.rows[0] ?? {}
        const videoOps = videoOpsQ.rows[0] ?? {}

        const gmvTotal = round2(sales.gmv_total)
        const pedidosTotal = toInt(sales.pedidos_total)
        const ticketMedio = pedidosTotal > 0 ? round2(gmvTotal / pedidosTotal) : 0
        const gmvPrev = Number(prevSales.gmv_total ?? 0)
        const pedidosPrev = Number(prevSales.pedidos_total ?? 0)
        const ticketPrev = pedidosPrev > 0 ? gmvPrev / pedidosPrev : 0
        const pct = (current, previous) => previous > 0 ? Math.round(((current - previous) / previous) * 100) : 0
        const totalLives = toInt(liveOps.total_lives)
        const totalVideos = toInt(videoOps.total_videos)
        const totalConteudos = totalLives + totalVideos
        const gmvLives = round2(sales.gmv_lives)
        const gmvVideos = round2(sales.gmv_videos)
        const horasLive = round1(liveOps.horas_live)
        const pedidosLives = toInt(sales.pedidos_lives)
        const gmvPorLive = totalLives > 0 ? round2(gmvTotal / totalLives) : 0
        // GMV/hora = GMV de LIVES ÷ horas de live (exclui vídeo, que tem horas=0 e
        // inflaria o indicador). Mesma convenção do rollup (performance-rollups) e do funil.
        const gmvPorHora = horasLive > 0 ? round2(gmvLives / horasLive) : 0
        const ticketMedioLive = pedidosLives > 0 ? round2(gmvLives / pedidosLives) : 0
        const hoursRows = hoursQ.rows
        const monthlyRows = monthlyQ.rows.map((row) => ({
          mes: row.mes,
          gmv: round2(row.gmv),
          gmv_total: round2(row.gmv),
          gmv_lives: round2(row.gmv_lives),
          gmv_videos: round2(row.gmv_videos),
          pedidos: toInt(row.pedidos),
          total_vendas: toInt(row.pedidos),
          total_lives: toInt(row.total_lives),
          total_videos: toInt(row.total_videos),
        }))
        const pedidosMensal = monthlyRows.map((row) => ({
          mes: row.mes,
          pedidos: row.pedidos,
          total_vendas: row.pedidos,
        }))

        const rankingApresentadoras = presenterRankingQ.map((row) => ({
          apresentadora_id: row.apresentadora_id,
          apresentador_id: row.apresentadora_id,
          apresentadora_nome: row.apresentadora_nome,
          apresentador_nome: row.apresentadora_nome,
          apresentadora_foto_url: row.apresentadora_foto_url,
          total_lives: toInt(row.total_lives),
          total_videos: toInt(row.total_videos),
          pedidos: toInt(row.pedidos),
          gmv_total: round2(row.gmv_total),
          gmv_lives: round2(row.gmv_lives),
          gmv_videos: round2(row.gmv_videos),
        }))

        const rankingMarcas = brandRankingQ.map((row) => ({
          marca_id: row.marca_id,
          marca_nome: row.marca_nome,
          nome: row.marca_nome,
          logo_url: row.logo_url,
          total_lives: toInt(row.total_lives),
          total_videos: toInt(row.total_videos),
          pedidos: toInt(row.pedidos),
          gmv_total: round2(row.gmv_total),
          gmv_lives: round2(row.gmv_lives),
          gmv_videos: round2(row.gmv_videos),
        }))

        return {
          periodo: { from: fromDate, to: toDate, mesAno },
          kpis: {
            gmv_total: gmvTotal,
            faturamento_total: gmvTotal,
            gmv_lives: gmvLives,
            gmv_videos: gmvVideos,
            pedidos_total: pedidosTotal,
            total_vendas: pedidosTotal,
            pedidos_lives: pedidosLives,
            pedidos_videos: toInt(sales.pedidos_videos),
            ticket_medio: ticketMedio,
            ticket_medio_live: ticketMedioLive,
            total_lives: totalLives,
            total_videos: totalVideos,
            total_conteudos: totalConteudos,
            registros_video: toInt(videoOps.registros_video),
            horas_live: horasLive,
            total_horas_no_ar: horasLive,
            gmv_por_live: gmvPorLive,
            gmv_por_hora: gmvPorHora,
            gmv_hora: gmvPorHora,
            viewers_total: toInt(liveOps.viewers_total),
            audiencia_media: totalLives > 0 ? Math.round(toInt(liveOps.viewers_total) / totalLives) : 0,
            likes_total: toInt(liveOps.likes_total),
            comentarios_total: toInt(liveOps.comentarios_total),
            shares_total: toInt(liveOps.shares_total),
            diamonds_total: toInt(liveOps.diamonds_total),
            like_rate_medio: liveOps.like_rate_medio == null ? null : Number(liveOps.like_rate_medio),
            novos_seguidores: toInt(liveOps.novos_seguidores),
            delta_gmv: pct(gmvTotal, gmvPrev),
            delta_faturamento: pct(gmvTotal, gmvPrev),
            delta_pedidos: pct(pedidosTotal, pedidosPrev),
            delta_vendas: pct(pedidosTotal, pedidosPrev),
            delta_ticket: pct(ticketMedio, ticketPrev),
          },
          gmv_total: gmvTotal,
          gmv_mes: gmvTotal,
          gmv_lives: gmvLives,
          gmv_videos: gmvVideos,
          pedidos_total: pedidosTotal,
          pedidos: pedidosTotal,
          total_lives: totalLives,
          lives_realizadas: totalLives,
          total_videos: totalVideos,
          videos_gravados: totalVideos,
          total_conteudos: totalConteudos,
          horas_live: horasLive,
          ticket_medio: ticketMedio,
          ticket_medio_live: ticketMedioLive,
          gmv_por_live: gmvPorLive,
          gmv_por_hora: gmvPorHora,
          gmv_hora: gmvPorHora,
          viewers_total: toInt(liveOps.viewers_total),
          likes_total: toInt(liveOps.likes_total),
          comentarios_total: toInt(liveOps.comentarios_total),
          shares_total: toInt(liveOps.shares_total),
          diamonds_total: toInt(liveOps.diamonds_total),
          like_rate_medio: liveOps.like_rate_medio == null ? null : Number(liveOps.like_rate_medio),
          novos_seguidores: toInt(liveOps.novos_seguidores),
          gmv_mensal: monthlyRows,
          faturamento_mensal: monthlyRows,
          pedidos_mensal: pedidosMensal,
          vendas_mensal: pedidosMensal,
          horas_live_por_dia: hoursRows.map((row) => ({
            dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
            horas: round1(row.horas),
            gmv_total: round2(row.gmv_lives),
            gmv_lives: round2(row.gmv_lives),
            pedidos: toInt(row.pedidos_lives),
          })),
          gmv_diario: hoursRows.map((row) => ({
            dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
            gmv_total: round2(row.gmv_lives),
            gmv_lives: round2(row.gmv_lives),
          })),
          pedidos_diario: hoursRows.map((row) => ({
            dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
            pedidos: toInt(row.pedidos_lives),
            total_pedidos: toInt(row.pedidos_lives),
          })),
          ranking_apresentadoras: rankingApresentadoras,
          ranking_apresentadores: rankingApresentadoras,
          ranking_marcas: rankingMarcas,

          peak_hours: peakHoursQ.rows.map((row) => ({
            hora: toInt(row.hora),
            total_lives: toInt(row.total_lives),
            gmv: round2(row.gmv),
          })),
          heatmap_conversao: heatmapQ.rows.map((row) => ({
            dow: toInt(row.dow),
            bloco_hora: toInt(row.bloco_hora),
            gmv: round2(row.gmv),
            lives: toInt(row.lives),
          })),
        }
        }),
      })
      setCacheControl(reply, state, startedAt)
      return value
    } catch (err) {
      request.log.error({ err }, 'analytics/dashboard error')
      return reply.code(500).send({ error: err.message })
    }
  })

  // ── Funil de conversão de lives ────────────────────────────────────────
  // Agrega o caminho impressões → visualizações → impressões de produto →
  // cliques → pedidos no período (lives encerradas ≥ 5 min), com filtro
  // opcional por marca/apresentadora. As etapas de Ads dependem do import
  // do TikTok Ads Manager (tem_dados_ads sinaliza se há dados de funil).

  app.get('/v1/analytics/funil', {
    preHandler: [app.authenticate, app.requirePapel(READ_ANALYTICS)],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          mesAno: { type: 'string' },
          mes: { type: 'string' },
          ano: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          marca_id: { type: 'string' },
          apresentadora_id: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const period = resolveAnalyticsPeriod(request.query)
    if (period.error) return reply.code(400).send({ error: period.error })
    const { fromDate, toDate, mesAno } = period

    const marcaId = request.query?.marca_id ? String(request.query.marca_id) : null
    const apresentadoraId = request.query?.apresentadora_id ? String(request.query.apresentadora_id) : null
    if (marcaId && !UUID_RE.test(marcaId)) return reply.code(400).send({ error: 'marca_id must be a valid UUID' })
    if (apresentadoraId && !UUID_RE.test(apresentadoraId)) return reply.code(400).send({ error: 'apresentadora_id must be a valid UUID' })

    try {
      return await app.withTenant(tenant_id, async (db) => {
        const result = await db.query(`
          SELECT
            COUNT(*)::int AS total_lives,
            COALESCE(SUM(
              CASE
                WHEN $4::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
                  THEN COALESCE(
                    ap_v2.gmv_rateado,
                    COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) * ap_v2.percentual_rateio / 100.0,
                    CASE WHEN ap_v2.papel = 'principal' THEN COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) ELSE 0 END
                  )
                ELSE COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)
              END
            ), 0) AS gmv,
            COALESCE(SUM(
              CASE
                WHEN $4::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
                  THEN COALESCE(live_sales.pedidos, CASE WHEN ap_v2.papel = 'principal' THEN COALESCE(l.manual_orders, l.final_orders_count, 0) ELSE 0 END)
                ELSE COALESCE(l.manual_orders, l.final_orders_count, 0)
              END
            ), 0)::bigint AS pedidos,
            COALESCE(SUM(COALESCE(l.live_impressions, 0)), 0)::bigint AS impressoes,
            COALESCE(SUM(COALESCE(l.manual_views, l.final_peak_viewers, 0)), 0)::bigint AS visualizacoes,
            COALESCE(SUM(COALESCE(l.product_impressions, 0)), 0)::bigint AS impressoes_produto,
            COALESCE(SUM(COALESCE(l.product_clicks, 0)), 0)::bigint AS cliques,
            COALESCE(SUM(
              CASE
                WHEN $4::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
                  THEN COALESCE(
                    ap_v2.segundos_rateio / 3600.0,
                    LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0) * ap_v2.percentual_rateio / 100.0,
                    CASE WHEN ap_v2.papel = 'principal' THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0) ELSE 0 END
                  )
                WHEN COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
                  THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
                ELSE 0
              END
            ), 0) AS horas_live,
            COALESCE(SUM(COALESCE(l.manual_likes, l.final_total_likes, 0)), 0)::bigint AS likes,
            COALESCE(SUM(COALESCE(l.new_followers, 0)), 0)::bigint AS novos_seguidores,
            ROUND(AVG(NULLIF((l.studio_metrics->>'like_rate')::numeric, 0)), 2) AS like_rate_medio
          FROM lives l
          LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
          LEFT JOIN LATERAL (
            SELECT lav.apresentadora_id, lav.gmv_rateado, lav.segundos_rateio,
                   lav.percentual_rateio, lav.papel
            FROM live_apresentadoras_v2 lav
            WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
              AND ($4::uuid IS NULL OR lav.apresentadora_id = $4::uuid)
            ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
            LIMIT 1
          ) ap_v2 ON true
          LEFT JOIN LATERAL (
            SELECT SUM(va.pedidos)::int AS pedidos
            FROM vendas_atribuidas va
            WHERE va.tenant_id = l.tenant_id
              AND va.origem = 'live'
              AND va.origem_id = l.id
              AND va.apresentadora_id = COALESCE(ap_v2.apresentadora_id, ap_user.id)
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
          ) live_sales ON true
          WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND l.status = 'encerrada'
            AND COALESCE(l.encerrado_em, l.previsto_fim) IS NOT NULL
            AND COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
            AND EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) >= 300
            AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date >= $1::date
            AND (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date <= $2::date
            AND ($3::uuid IS NULL OR l.marca_id = $3::uuid)
            AND ($4::uuid IS NULL OR COALESCE(ap_v2.apresentadora_id, ap_user.id) = $4::uuid)
        `, [fromDate, toDate, marcaId, apresentadoraId])

        const r = result.rows[0] || {}
        const impressoes = toInt(r.impressoes)
        const visualizacoes = toInt(r.visualizacoes)
        const impressoesProduto = toInt(r.impressoes_produto)
        const cliques = toInt(r.cliques)
        const pedidos = toInt(r.pedidos)
        const gmv = round2(r.gmv)
        const horasLive = round1(r.horas_live)
        const totalLives = toInt(r.total_lives)

        const rate = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null)
        const rawStages = [
          { chave: 'impressoes', label: 'Impressões da live', valor: impressoes },
          { chave: 'visualizacoes', label: 'Visualizações', valor: visualizacoes },
          { chave: 'impressoes_produto', label: 'Impressões de produto', valor: impressoesProduto },
          { chave: 'cliques', label: 'Cliques no produto', valor: cliques },
          { chave: 'pedidos', label: 'Pedidos', valor: pedidos },
        ]
        const topo = rawStages[0].valor
        const etapas = rawStages.map((s, i) => ({
          chave: s.chave,
          label: s.label,
          valor: s.valor,
          taxa_etapa: i === 0 ? null : rate(s.valor, rawStages[i - 1].valor),
          taxa_total: rate(s.valor, topo),
        }))

        return {
          periodo: { from: fromDate, to: toDate, mesAno },
          filtros: { marca_id: marcaId, apresentadora_id: apresentadoraId },
          tem_dados_ads: impressoes > 0 || impressoesProduto > 0 || cliques > 0,
          resumo: {
            total_lives: totalLives,
            gmv,
            pedidos,
            ticket_medio: pedidos > 0 ? round2(gmv / pedidos) : 0,
            horas_live: horasLive,
            gmv_por_hora: horasLive > 0 ? round2(gmv / horasLive) : 0,
            visualizacoes,
            likes: Number(r.likes ?? 0),
            novos_seguidores: Number(r.novos_seguidores ?? 0),
            // % de likes reportada pelo TikTok Studio — usa espectadores únicos como
            // denominador, que não vem na planilha, então não é recalculável aqui.
            like_rate_medio: r.like_rate_medio == null ? null : Number(r.like_rate_medio),
          },
          etapas,
        }
      })
    } catch (err) {
      request.log.error({ err }, 'analytics/funil error')
      return reply.code(500).send({ error: err.message })
    }
  })

  app.get('/v1/analytics/diario', {
    preHandler: [app.authenticate, app.requirePapel(READ_ANALYTICS)],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          mesAno: { type: 'string' },
          mes: { type: 'string' },
          ano: { type: 'string' },
          marca_id: { type: 'string' },
          apresentadora_id: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const period = resolveAnalyticsPeriod(request.query)
    if (period.error) return reply.code(400).send({ error: period.error })

    const marcaId = request.query?.marca_id ? String(request.query.marca_id) : null
    const apresentadoraId = request.query?.apresentadora_id ? String(request.query.apresentadora_id) : null
    if (marcaId && !UUID_RE.test(marcaId)) return reply.code(400).send({ error: 'marca_id must be a valid UUID' })
    if (apresentadoraId && !UUID_RE.test(apresentadoraId)) return reply.code(400).send({ error: 'apresentadora_id must be a valid UUID' })

    const { fromDate, toDate, mesAno } = period
    const startedAt = performance.now()
    const cacheKey = buildCacheKey(tenant_id, {
      from: fromDate,
      to: toDate,
      marca_id: marcaId,
      apresentadora_id: apresentadoraId,
    })
    try {
      const { value, state } = await withCache({
        namespace: 'analytics:diario',
        key: cacheKey,
        ttlMs: ANALYTICS_DIARIO_CACHE_TTL_MS,
        computeFn: () => app.withTenant(tenant_id, async (db) => {
        const result = await db.query(`
          WITH live_base AS (
            SELECT
              (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date AS dia,
              l.marca_id,
              COALESCE(m.nome, 'Sem marca') AS marca_nome,
              COALESCE(ap_v2.apresentadora_id, ap_user.id) AS apresentadora_id,
              COALESCE(ap_v2.nome, ap_user.nome, u.nome, 'Sem apresentadora') AS apresentadora_nome,
              CASE
                WHEN $4::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
                  THEN COALESCE(
                    ap_v2.gmv_rateado,
                    COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) * ap_v2.percentual_rateio / 100.0,
                    CASE WHEN ap_v2.papel = 'principal' THEN COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) ELSE 0 END
                  )
                ELSE COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)
              END AS gmv,
              CASE
                WHEN $4::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
                  THEN COALESCE(live_sales.pedidos, CASE WHEN ap_v2.papel = 'principal' THEN COALESCE(l.manual_orders, l.final_orders_count, 0) ELSE 0 END)
                ELSE COALESCE(l.manual_orders, l.final_orders_count, 0)
              END::int AS pedidos,
              CASE
                WHEN $4::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
                  THEN COALESCE(
                    ap_v2.segundos_rateio / 3600.0,
                    LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0) * ap_v2.percentual_rateio / 100.0,
                    CASE WHEN ap_v2.papel = 'principal' THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0) ELSE 0 END
                  )
                WHEN COALESCE(l.encerrado_em, l.previsto_fim) IS NOT NULL
                 AND COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
                  THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
                ELSE 0
              END AS horas
            FROM lives l
            LEFT JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
            LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
            LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
            LEFT JOIN LATERAL (
              SELECT lav.apresentadora_id, a.nome, lav.gmv_rateado, lav.segundos_rateio,
                     lav.percentual_rateio, lav.papel
              FROM live_apresentadoras_v2 lav
              JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
              WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
                AND ($4::uuid IS NULL OR lav.apresentadora_id = $4::uuid)
              ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
              LIMIT 1
            ) ap_v2 ON true
            LEFT JOIN LATERAL (
              SELECT SUM(va.pedidos)::int AS pedidos
              FROM vendas_atribuidas va
              WHERE va.tenant_id = l.tenant_id
                AND va.origem = 'live'
                AND va.origem_id = l.id
                AND va.apresentadora_id = COALESCE(ap_v2.apresentadora_id, ap_user.id)
                AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
            ) live_sales ON true
            WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND l.status = 'encerrada'
              AND l.iniciado_em >= ($1::date) AT TIME ZONE '${ANALYTICS_TZ}'
              AND l.iniciado_em < (($2::date) + 1) AT TIME ZONE '${ANALYTICS_TZ}'
              AND ($3::uuid IS NULL OR l.marca_id = $3::uuid)
              AND ($4::uuid IS NULL OR COALESCE(ap_v2.apresentadora_id, ap_user.id) = $4::uuid)
          ),
          live_daily AS (
            SELECT
              dia,
              marca_id,
              marca_nome,
              apresentadora_id,
              apresentadora_nome,
              COUNT(*)::int AS total_lives,
              COALESCE(SUM(gmv), 0) AS gmv_lives,
              COALESCE(SUM(pedidos), 0)::int AS pedidos_lives,
              COALESCE(SUM(horas), 0) AS horas_live
            FROM live_base
            GROUP BY dia, marca_id, marca_nome, apresentadora_id, apresentadora_nome
          ),
          video_daily AS (
            SELECT
              va.data::date AS dia,
              va.marca_id,
              COALESCE(m.nome, 'Sem marca') AS marca_nome,
              va.apresentadora_id,
              COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome,
              COALESCE(SUM(va.gmv), 0) AS gmv_videos,
              COALESCE(SUM(va.pedidos), 0)::int AS pedidos_videos,
              COUNT(DISTINCT va.origem_id)::int AS total_videos
            FROM vendas_atribuidas va
            LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
            LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
            WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND va.origem = 'video'
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
              AND va.data >= $1::date
              AND va.data <= $2::date
              AND ($3::uuid IS NULL OR va.marca_id = $3::uuid)
              AND ($4::uuid IS NULL OR va.apresentadora_id = $4::uuid)
            GROUP BY va.data::date, va.marca_id, COALESCE(m.nome, 'Sem marca'), va.apresentadora_id, COALESCE(a.nome, 'Sem apresentadora')
          ),
          comissao_daily AS (
            -- Comissão da apresentadora por (dia, marca, apresentadora), da fonte
            -- autoritativa (vendas_atribuidas). gmv_base = GMV que gerou a comissão,
            -- usado como denominador do % aplicado (consistente com /comissoes/*).
            SELECT
              va.data::date AS dia,
              va.marca_id,
              va.apresentadora_id,
              COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao,
              COALESCE(SUM(va.gmv), 0) AS gmv_base
            FROM vendas_atribuidas va
            WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
              AND va.data >= $1::date
              AND va.data <= $2::date
              AND ($3::uuid IS NULL OR va.marca_id = $3::uuid)
              AND ($4::uuid IS NULL OR va.apresentadora_id = $4::uuid)
            GROUP BY va.data::date, va.marca_id, va.apresentadora_id
          )
          SELECT
            COALESCE(ld.dia, vd.dia) AS dia,
            COALESCE(ld.marca_id, vd.marca_id) AS marca_id,
            COALESCE(ld.marca_nome, vd.marca_nome, 'Sem marca') AS marca_nome,
            COALESCE(ld.apresentadora_id, vd.apresentadora_id) AS apresentadora_id,
            COALESCE(ld.apresentadora_nome, vd.apresentadora_nome, 'Sem apresentadora') AS apresentadora_nome,
            COALESCE(ld.total_lives, 0)::int AS total_lives,
            COALESCE(vd.total_videos, 0)::int AS total_videos,
            COALESCE(ld.gmv_lives, 0) AS gmv_lives,
            COALESCE(vd.gmv_videos, 0) AS gmv_videos,
            COALESCE(ld.horas_live, 0) AS horas_live,
            (COALESCE(ld.pedidos_lives, 0) + COALESCE(vd.pedidos_videos, 0))::int AS pedidos,
            COALESCE(cd.comissao, 0) AS comissao_apresentadora,
            COALESCE(cd.gmv_base, 0) AS comissao_gmv_base
          FROM live_daily ld
          FULL OUTER JOIN video_daily vd
            ON vd.dia = ld.dia
           AND vd.marca_id IS NOT DISTINCT FROM ld.marca_id
           AND vd.apresentadora_id IS NOT DISTINCT FROM ld.apresentadora_id
          LEFT JOIN comissao_daily cd
            ON cd.dia = COALESCE(ld.dia, vd.dia)
           AND cd.marca_id IS NOT DISTINCT FROM COALESCE(ld.marca_id, vd.marca_id)
           AND cd.apresentadora_id IS NOT DISTINCT FROM COALESCE(ld.apresentadora_id, vd.apresentadora_id)
          WHERE
            COALESCE(ld.total_lives, 0) > 0
            OR COALESCE(vd.total_videos, 0) > 0
            OR COALESCE(ld.gmv_lives, 0) > 0
            OR COALESCE(vd.gmv_videos, 0) > 0
            OR COALESCE(ld.horas_live, 0) > 0
            OR (COALESCE(ld.pedidos_lives, 0) + COALESCE(vd.pedidos_videos, 0)) > 0
          ORDER BY dia ASC, marca_nome ASC, apresentadora_nome ASC
        `, [fromDate, toDate, marcaId, apresentadoraId])

        return {
          periodo: { from: fromDate, to: toDate, mesAno },
          filters: { marca_id: marcaId, apresentadora_id: apresentadoraId },
          rows: result.rows.map((row) => {
            const gmvLives = round2(row.gmv_lives)
            const gmvVideos = round2(row.gmv_videos)
            const gmvTotal = round2(gmvLives + gmvVideos)
            const totalLives = toInt(row.total_lives)
            const horasLive = round1(row.horas_live)
            const pedidos = toInt(row.pedidos)
            const comissao = round2(row.comissao_apresentadora)
            const comissaoBase = round2(row.comissao_gmv_base)
            const comissaoPct = comissaoBase > 0 ? round2((comissao / comissaoBase) * 100) : 0
            return {
              dia: typeof row.dia === 'string' ? row.dia : row.dia.toISOString().slice(0, 10),
              marca_id: row.marca_id ?? null,
              marca_nome: row.marca_nome ?? 'Sem marca',
              apresentadora_id: row.apresentadora_id ?? null,
              apresentadora_nome: row.apresentadora_nome ?? 'Sem apresentadora',
              gmv_total: gmvTotal,
              gmv_lives: gmvLives,
              gmv_videos: gmvVideos,
              total_lives: totalLives,
              total_videos: toInt(row.total_videos),
              horas_live: horasLive,
              gmv_por_live: totalLives > 0 ? round2(gmvTotal / totalLives) : 0,
              // GMV/hora = GMV de lives ÷ horas (exclui vídeo); padroniza com o rollup/funil.
              gmv_por_hora: horasLive > 0 ? round2(gmvLives / horasLive) : 0,
              pedidos,
              ticket_medio: pedidos > 0 ? round2(gmvTotal / pedidos) : 0,
              comissao_apresentadora: comissao,
              comissao_pct: comissaoPct,
            }
          }),
        }
        }),
      })
      setCacheControl(reply, state, startedAt)
      return value
    } catch (err) {
      request.log.error({ err }, 'analytics/diario error')
      return reply.code(500).send({ error: err.message })
    }
  })
}
