import { lockTenantLiveFinance } from '../lib/live-finance-lock.js'
import { activeLiveSql } from '../lib/live-merge-sql.js'
import { vencimentoSql } from '../lib/receita-marca-sql.js'
import {
  CAMPOS_VENCIMENTO,
  VENCIMENTO_PADRAO,
  conditionPayloadHash,
  normalizarMarcaCondicao,
  normalizarVencimentoCondicao,
  resolveMarcaCondicao,
  resolverVencimentoCondicao,
} from '../lib/marca-condicoes.js'

const MONTH_DATE_RE = /^\d{4}-\d{2}-01$/

function serviceError(message, code, statusCode = 409, details = {}) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  Object.assign(error, details)
  return error
}

function ensureIds({ tenantId, marcaId }) {
  if (!tenantId || !marcaId) throw serviceError('tenantId e marcaId são obrigatórios', 'INVALID_SCOPE', 400)
}

function normalizeRevision(value) {
  if (value == null || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw serviceError('revisão esperada é obrigatória', 'EXPECTED_REVISION_REQUIRED', 409)
  }
  return Number(value)
}

function monthAfter(monthStart) {
  const [year, month] = monthStart.split('-').map(Number)
  return month === 12
    ? `${String(year + 1).padStart(4, '0')}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`
}

function conditionRowToPublic(row) {
  if (!row) return null
  const inicioVigencia = row.inicio_vigencia instanceof Date
    ? row.inicio_vigencia.toISOString().slice(0, 10)
    : String(row.inicio_vigencia).slice(0, 10)
  const fixoConfirmado = Boolean(row.fixo_confirmado)
  const comissaoConfirmada = Boolean(row.comissao_confirmada)
  const origem = row.origem ?? null
  // Mesma regra da UI / buildConfiguracaoComercial: baseline 1900 sem confirmação
  // aparece como “Legado a revisar”, não como zero financeiro autoritativo.
  const aRevisar = origem === 'legado_nao_verificado' && !fixoConfirmado && !comissaoConfirmada
  return {
    ...row,
    inicio_vigencia: inicioVigencia,
    // Alias do campo “Competência” no painel (input type=month → AAAA-MM).
    competencia: inicioVigencia.slice(0, 7),
    fixo_mensal: Number(row.fixo_mensal ?? 0),
    comissao_franquia_pct: Number(row.comissao_franquia_pct ?? 0),
    comissao_franqueadora_pct: Number(row.comissao_franqueadora_pct ?? 0),
    tipo_cobranca: row.tipo_cobranca ?? 'fixo_mais_comissao',
    fixo_confirmado: fixoConfirmado,
    comissao_confirmada: comissaoConfirmada,
    origem,
    a_revisar: aRevisar,
    revision: Number(row.revision ?? 1),
    ...vencimentoPublico(row),
  }
}

/** Vencimento da condição (migration 165); linha sem as colunas assume o padrão. */
function vencimentoPublico(row = {}) {
  return Object.fromEntries(CAMPOS_VENCIMENTO.map((campo) => [
    campo,
    row[campo] == null ? VENCIMENTO_PADRAO[campo] : Number(row[campo]),
  ]))
}

/** Shape público da proposta (reais / %), alinhado ao formulário do painel. */
function proposalToPublic(normalized) {
  if (!normalized) return null
  if (normalized.fixo_mensal_cents == null) {
    return {
      ...normalized,
      competencia: String(normalized.inicio_vigencia ?? '').slice(0, 7),
      fixo_mensal: Number(normalized.fixo_mensal ?? 0),
      comissao_franquia_pct: Number(normalized.comissao_franquia_pct ?? 0),
      comissao_franqueadora_pct: Number(normalized.comissao_franqueadora_pct ?? 0),
    }
  }
  return {
    inicio_vigencia: normalized.inicio_vigencia,
    competencia: String(normalized.inicio_vigencia).slice(0, 7),
    fixo_mensal: Number((normalized.fixo_mensal_cents / 100).toFixed(2)),
    comissao_franquia_pct: Number((normalized.comissao_franquia_basis / 100).toFixed(2)),
    comissao_franqueadora_pct: Number((normalized.comissao_franqueadora_basis / 100).toFixed(2)),
    tipo_cobranca: normalized.tipo_cobranca,
    fixo_confirmado: Boolean(normalized.fixo_confirmado),
    comissao_confirmada: Boolean(normalized.comissao_confirmada),
    origem: normalized.origem ?? 'gestao',
    motivo: normalized.motivo ?? null,
    ...Object.fromEntries(CAMPOS_VENCIMENTO
      .filter((campo) => normalized[campo] != null)
      .map((campo) => [campo, Number(normalized[campo])])),
  }
}

async function listRows(db, { tenantId, marcaId, includeCancelled = false }) {
  const result = await db.query(
    `SELECT id, tenant_id, marca_id, inicio_vigencia, fixo_mensal,
            comissao_franquia_pct, comissao_franqueadora_pct, tipo_cobranca,
            fixo_confirmado, comissao_confirmada, origem, motivo, created_by,
            created_at, revision, cancelled_at, idempotency_key,
            fixo_vencimento_dia, fixo_vencimento_mes_offset,
            comissao_vencimento_dia, comissao_vencimento_mes_offset,
            comissao_janela_inicio_dia
       FROM marca_condicoes_comerciais
      WHERE tenant_id = $1::uuid AND marca_id = $2::uuid
        ${includeCancelled ? '' : 'AND cancelled_at IS NULL'}
      ORDER BY inicio_vigencia DESC, revision DESC, created_at DESC`,
    [tenantId, marcaId],
  )
  return result.rows.map(conditionRowToPublic)
}

async function lockMarca(db, { tenantId, marcaId }) {
  const result = await db.query(
    `SELECT id, tenant_id, nome, tipo, valor_fixo_minimo,
            comissao_franquia_pct, comissao_franqueadora_pct, tipo_cobranca
       FROM marcas
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      FOR UPDATE`,
    [tenantId, marcaId],
  )
  if (!result.rows[0]) throw serviceError('Marca não encontrada', 'MARCA_NOT_FOUND', 404)
  return result.rows[0]
}

async function readImpact(db, { tenantId, marcaId, start, end }) {
  const [lives, sales] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE l.faturado_em IS NOT NULL)::int AS fechados,
         COUNT(*) FILTER (WHERE l.faturado_em IS NULL)::int AS abertos,
         COALESCE(SUM(l.fat_gerado) FILTER (WHERE l.faturado_em IS NULL), 0) AS gmv_aberto
       FROM lives l
      WHERE l.tenant_id = $1::uuid AND l.marca_id = $2::uuid
        AND l.iniciado_em >= ($3::date AT TIME ZONE 'America/Sao_Paulo')
        AND l.iniciado_em < ($4::date AT TIME ZONE 'America/Sao_Paulo')
        AND ${activeLiveSql('l')}`,
      [tenantId, marcaId, start, end],
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE COALESCE(va.status_aprovacao, 'pendente_aprovacao') IN ('aprovada', 'fechada', 'faturada'))::int AS fechados,
         COUNT(*) FILTER (WHERE COALESCE(va.status_aprovacao, 'pendente_aprovacao') NOT IN ('aprovada', 'fechada', 'faturada', 'reprovada'))::int AS abertos,
         COALESCE(SUM(va.gmv) FILTER (WHERE COALESCE(va.status_aprovacao, 'pendente_aprovacao') NOT IN ('aprovada', 'fechada', 'faturada', 'reprovada')), 0) AS gmv_aberto
       FROM vendas_atribuidas va
      WHERE va.tenant_id = $1::uuid AND va.marca_id = $2::uuid
        AND va.data >= $3::date AND va.data < $4::date`,
      [tenantId, marcaId, start, end],
    ),
  ])
  const live = lives.rows[0] ?? {}
  const sale = sales.rows[0] ?? {}
  return {
    lives: { abertos: Number(live.abertos ?? 0), fechados: Number(live.fechados ?? 0) },
    vendas: { abertos: Number(sale.abertos ?? 0), fechados: Number(sale.fechados ?? 0) },
    movimentos_abertos: Number(live.abertos ?? 0) + Number(sale.abertos ?? 0),
    movimentos_fechados: Number(live.fechados ?? 0) + Number(sale.fechados ?? 0),
    gmv_aberto: Number(live.gmv_aberto ?? 0) + Number(sale.gmv_aberto ?? 0),
  }
}

async function openMovementBreakdown(db, { tenantId, marcaId, start, end }) {
  const result = await db.query(
    `SELECT va.data::date AS competencia, COALESCE(SUM(va.gmv), 0) AS gmv
       FROM vendas_atribuidas va
      WHERE va.tenant_id = $1::uuid AND va.marca_id = $2::uuid
        AND va.data >= $3::date AND va.data < $4::date
        AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') NOT IN ('aprovada', 'fechada', 'faturada', 'reprovada')
      GROUP BY va.data::date
      ORDER BY va.data::date`,
    [tenantId, marcaId, start, end],
  )
  return result.rows.map((row) => ({ competencia: String(row.competencia).slice(0, 10), gmv: Number(row.gmv ?? 0) }))
}

function dateValue(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function monthStartFromDate(value) {
  const date = dateValue(value)
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(0, 7)}-01` : null
}

// Sem uma sucessora, o intervalo lógico é aberto. Para manter a prévia e o
// recálculo finitos, materializamos somente até o mês seguinte ao último
// movimento já existente. Movimentos criados depois dessa confirmação usarão
// o resolver temporal (T9+) e não precisam ser reescritos retroativamente.
async function movementHorizonEnd(db, { tenantId, marcaId, start }) {
  const result = await db.query(
    `SELECT MAX(competencia) AS ultima_competencia
       FROM (
         SELECT (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date AS competencia
           FROM lives l
          WHERE l.tenant_id = $1::uuid AND l.marca_id = $2::uuid
            AND (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $3::date
            AND ${activeLiveSql('l')}
         UNION ALL
         SELECT va.data::date AS competencia
           FROM vendas_atribuidas va
          WHERE va.tenant_id = $1::uuid AND va.marca_id = $2::uuid
            AND va.data >= $3::date
            AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') NOT IN ('aprovada', 'fechada', 'faturada', 'reprovada')
       ) movimentos`,
    [tenantId, marcaId, start],
  )
  const lastMonth = monthStartFromDate(result.rows[0]?.ultima_competencia)
  return lastMonth ? monthAfter(lastMonth) : monthAfter(start)
}

async function previewInTransaction(db, { tenantId, marcaId, proposal, conditions }) {
  const nextExisting = conditions
    .filter((condition) => condition.inicio_vigencia > proposal.inicio_vigencia)
    .sort((a, b) => String(a.inicio_vigencia).localeCompare(String(b.inicio_vigencia)))[0]
  const horizonEnd = await movementHorizonEnd(db, { tenantId, marcaId, start: proposal.inicio_vigencia })
  const end = nextExisting && nextExisting.inicio_vigencia < horizonEnd
    ? nextExisting.inicio_vigencia
    : horizonEnd
  const impact = await readImpact(db, { tenantId, marcaId, start: proposal.inicio_vigencia, end })
  const movements = await openMovementBreakdown(db, { tenantId, marcaId, start: proposal.inicio_vigencia, end })
  const anterior = resolveMarcaCondicao(conditions, proposal.inicio_vigencia)
  return {
    inicio_vigencia: proposal.inicio_vigencia,
    competencia: String(proposal.inicio_vigencia).slice(0, 7),
    fim_vigencia_exclusivo: end,
    // Vencimento ausente na proposta herda da condição anterior (ou do padrão dia 5/mês seguinte).
    proposta: proposalToPublic({ ...proposal, ...resolverVencimentoCondicao(proposal, anterior) }),
    condicao_anterior: anterior ? conditionRowToPublic(anterior) : null,
    impacto: impact,
    movimentos_abertos: movements,
    requer_confirmacao: true,
    bloqueada: impact.movimentos_fechados > 0,
  }
}

/** Lista o histórico sem projetar os campos atuais da marca sobre o passado. */
export async function listarCondicoesMarca(db, { tenantId, marcaId } = {}) {
  ensureIds({ tenantId, marcaId })
  const marca = await db.query(
    `SELECT id FROM marcas WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, marcaId],
  )
  if (!marca.rows[0]) throw serviceError('Marca não encontrada', 'MARCA_NOT_FOUND', 404)
  return listRows(db, { tenantId, marcaId })
}

function origemServidor(origem) {
  return origem === 'bot' ? 'bot' : 'gestao'
}

/** Prévia isolada: nenhuma tabela é escrita e o resultado é descartável. */
export async function preverCondicaoMarca(db, { tenantId, marcaId, proposta, condition, origem } = {}) {
  ensureIds({ tenantId, marcaId })
  const normalized = normalizarMarcaCondicao(proposta ?? condition ?? {}, { origem: origemServidor(origem) })
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await db.query(
      `SELECT id FROM marcas WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, marcaId],
    ).then((result) => {
      if (!result.rows[0]) throw serviceError('Marca não encontrada', 'MARCA_NOT_FOUND', 404)
    })
    const conditions = await listRows(db, { tenantId, marcaId })
    const duplicate = conditions.find((row) => row.inicio_vigencia === normalized.inicio_vigencia)
    if (duplicate) throw serviceError('Já existe condição para esta competência', 'CONDITION_EXISTS', 409)
    return await previewInTransaction(db, { tenantId, marcaId, proposal: normalized, conditions })
  } finally {
    await db.query('ROLLBACK').catch(() => {})
  }
}

async function recalculateOpenVendas(db, { tenantId, marcaId, start, end }) {
  await db.query(
    `WITH recalculated AS (
      SELECT va.id, va.gmv,
             (SELECT c.id
                FROM marca_condicoes_comerciais c
               WHERE c.tenant_id = va.tenant_id AND c.marca_id = va.marca_id
                 AND c.inicio_vigencia <= va.data AND c.cancelled_at IS NULL
               ORDER BY c.inicio_vigencia DESC LIMIT 1) AS marca_condicao_id,
             COALESCE((SELECT c.comissao_franquia_pct
                         FROM marca_condicoes_comerciais c
                        WHERE c.tenant_id = va.tenant_id AND c.marca_id = va.marca_id
                          AND c.inicio_vigencia <= va.data AND c.cancelled_at IS NULL
                        ORDER BY c.inicio_vigencia DESC LIMIT 1), 0) AS franquia_pct,
             COALESCE((SELECT c.comissao_franqueadora_pct
                         FROM marca_condicoes_comerciais c
                        WHERE c.tenant_id = va.tenant_id AND c.marca_id = va.marca_id
                          AND c.inicio_vigencia <= va.data AND c.cancelled_at IS NULL
                        ORDER BY c.inicio_vigencia DESC LIMIT 1), 0) AS franqueadora_pct
        FROM vendas_atribuidas va
       WHERE va.tenant_id = $1::uuid AND va.marca_id = $2::uuid
         AND va.data >= $3::date AND va.data < $4::date
         AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') NOT IN ('aprovada', 'fechada', 'faturada', 'reprovada')
    )
    UPDATE vendas_atribuidas va
        SET comissao_franquia = ROUND(r.gmv * r.franquia_pct / 100.0, 2),
            comissao_franqueadora = ROUND(r.gmv * r.franqueadora_pct / 100.0, 2),
            marca_condicao_id = r.marca_condicao_id,
            atualizado_em = NOW()
       FROM recalculated r
      WHERE va.id = r.id`,
    [tenantId, marcaId, start, end],
  )
}

async function recalculateOpenLives(db, { tenantId, marcaId, start, end }) {
  await db.query(
    `WITH recalculated AS (
      SELECT l.id, COALESCE(l.fat_gerado, 0) AS gmv,
             COALESCE((SELECT c.comissao_franquia_pct
                         FROM marca_condicoes_comerciais c
                        WHERE c.tenant_id = l.tenant_id AND c.marca_id = l.marca_id
                          AND c.inicio_vigencia <= (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
                          AND c.cancelled_at IS NULL
                        ORDER BY c.inicio_vigencia DESC LIMIT 1), 0) AS franquia_pct
        FROM lives l
       WHERE l.tenant_id = $1::uuid AND l.marca_id = $2::uuid
         AND l.iniciado_em >= ($3::date AT TIME ZONE 'America/Sao_Paulo')
         AND l.iniciado_em < ($4::date AT TIME ZONE 'America/Sao_Paulo')
         AND l.faturado_em IS NULL
         AND l.uniao_destino_id IS NULL AND l.uniao_desfeita_em IS NULL
    )
    UPDATE lives l
        SET comissao_calculada = ROUND(r.gmv * r.franquia_pct / 100.0, 2)
       FROM recalculated r
      WHERE l.id = r.id`,
    [tenantId, marcaId, start, end],
  )
}

async function auditCondition(db, { tenantId, actorUserId, marcaId, conditionId, proposal }) {
  await db.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, metadata)
     VALUES ($1::uuid, $2::uuid, 'marca_condicao.create', 'marca_condicao', $3::uuid, $4::jsonb)`,
    [tenantId, actorUserId ?? null, conditionId, JSON.stringify({ marca_id: marcaId, inicio_vigencia: proposal.inicio_vigencia, origem: proposal.origem })],
  )
}

/** Confirma uma condição com lock de tenant, marca, revisão e idempotência. */
export async function confirmarCondicaoMarca(db, {
  tenantId,
  marcaId,
  proposta,
  condition,
  expectedRevision,
  idempotencyKey,
  actorUserId = null,
  origem,
} = {}) {
  ensureIds({ tenantId, marcaId })
  const expected = normalizeRevision(expectedRevision)
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0 || idempotencyKey.length > 255) {
    throw serviceError('Idempotency-Key é obrigatório', 'IDEMPOTENCY_KEY_REQUIRED', 400)
  }
  const origemNormalizada = { origem: origemServidor(origem) }
  const normalized = normalizarMarcaCondicao(proposta ?? condition ?? {}, origemNormalizada)
  const payloadHash = conditionPayloadHash(proposta ?? condition ?? {}, origemNormalizada)
  await db.query('BEGIN')
  try {
    await lockTenantLiveFinance(db, tenantId)
    await lockMarca(db, { tenantId, marcaId })

    const previousRequest = await db.query(
      `SELECT * FROM marca_condicoes_comerciais
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND idempotency_key = $3
        FOR UPDATE`,
      [tenantId, marcaId, idempotencyKey],
    )
    if (previousRequest.rows[0]) {
      if (previousRequest.rows[0].payload_hash !== payloadHash) {
        throw serviceError('Idempotency-Key já foi usado com outra condição', 'IDEMPOTENCY_CONFLICT', 409)
      }
      await db.query('COMMIT')
      return { condition: conditionRowToPublic(previousRequest.rows[0]), idempotent: true, recalculated: false }
    }

    const conditions = await listRows(db, { tenantId, marcaId })
    const currentRevision = conditions.reduce((max, row) => Math.max(max, Number(row.revision ?? 1)), 0) || 1
    if (currentRevision !== expected) {
      throw serviceError('A revisão da marca mudou; atualize a prévia antes de confirmar', 'STALE_REVISION', 409, { currentRevision })
    }
    if (conditions.some((row) => row.inicio_vigencia === normalized.inicio_vigencia)) {
      throw serviceError('Já existe condição para esta competência', 'CONDITION_EXISTS', 409)
    }

    const preview = await previewInTransaction(db, { tenantId, marcaId, proposal: normalized, conditions })
    if (preview.bloqueada) {
      throw serviceError('A competência possui movimentos financeiros fechados', 'FINANCIAL_PERIOD_CLOSED', 409, { preview })
    }
    const vencimento = resolverVencimentoCondicao(
      normalized,
      resolveMarcaCondicao(conditions, normalized.inicio_vigencia),
    )
    const inserted = await db.query(
      `INSERT INTO marca_condicoes_comerciais (
         tenant_id, marca_id, inicio_vigencia, fixo_mensal,
         comissao_franquia_pct, comissao_franqueadora_pct, tipo_cobranca,
         fixo_confirmado, comissao_confirmada, origem, motivo, created_by,
         revision, idempotency_key,
         fixo_vencimento_dia, fixo_vencimento_mes_offset,
         comissao_vencimento_dia, comissao_vencimento_mes_offset,
         comissao_janela_inicio_dia,
         payload_hash
       ) VALUES ($1::uuid,$2::uuid,$3::date,$4,$5 / 100.0,$6 / 100.0,$7,$8,$9,$10,$11,$12::uuid,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        tenantId, marcaId, normalized.inicio_vigencia,
        normalized.fixo_mensal_cents / 100,
        normalized.comissao_franquia_basis,
        normalized.comissao_franqueadora_basis,
        normalized.tipo_cobranca, normalized.fixo_confirmado,
        normalized.comissao_confirmada, normalized.origem, normalized.motivo,
        actorUserId, currentRevision + 1, idempotencyKey,
        vencimento.fixo_vencimento_dia, vencimento.fixo_vencimento_mes_offset,
        vencimento.comissao_vencimento_dia, vencimento.comissao_vencimento_mes_offset,
        vencimento.comissao_janela_inicio_dia,
        payloadHash,
      ],
    )
    const created = inserted.rows[0]
    if (!created) throw new Error('Condição não foi criada')

    const end = preview.fim_vigencia_exclusivo
    await recalculateOpenVendas(db, { tenantId, marcaId, start: normalized.inicio_vigencia, end })
    await recalculateOpenLives(db, { tenantId, marcaId, start: normalized.inicio_vigencia, end })
    await db.query(
      `UPDATE marcas
          SET valor_fixo_minimo = $3, comissao_franquia_pct = $4,
              comissao_franqueadora_pct = $5, tipo_cobranca = $6, atualizado_em = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND $7::date <= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          AND NOT EXISTS (
            SELECT 1 FROM marca_condicoes_comerciais newer
             WHERE newer.tenant_id = $1::uuid AND newer.marca_id = $2::uuid
               AND newer.cancelled_at IS NULL
               AND newer.inicio_vigencia > $7::date
               AND newer.inicio_vigencia <= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          )`,
      [tenantId, marcaId, normalized.fixo_mensal_cents / 100, normalized.comissao_franquia_basis / 100, normalized.comissao_franqueadora_basis / 100, normalized.tipo_cobranca, normalized.inicio_vigencia],
    )
    await auditCondition(db, { tenantId, actorUserId, marcaId, conditionId: created.id, proposal: normalized })
    await db.query('COMMIT')
    return { condition: conditionRowToPublic(created), idempotent: false, recalculated: true, preview }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
}

/**
 * Ajusta SÓ o vencimento de uma versão existente (não mexe em valores, então
 * não exige nova vigência nem revisão). Títulos de receita ainda não recebidos
 * da vigência dessa versão acompanham a nova data; títulos com baixa ficam como estão.
 */
export async function atualizarVencimentoCondicao(db, {
  tenantId,
  marcaId,
  condicaoId,
  vencimento,
  actorUserId = null,
} = {}) {
  ensureIds({ tenantId, marcaId })
  if (!condicaoId) throw serviceError('condição é obrigatória', 'INVALID_SCOPE', 400)
  const campos = normalizarVencimentoCondicao(vencimento ?? {})
  if (Object.keys(campos).length === 0) {
    throw serviceError('Informe ao menos um campo de vencimento', 'INVALID_MARCA_CONDITION', 400)
  }
  await db.query('BEGIN')
  try {
    // Mudar a janela com títulos já materializados (qualquer status) na vigência da versão
    // reescreveria a competência do passado: exige nova versão com inicio_vigencia futuro.
    if (campos.comissao_janela_inicio_dia !== undefined) {
      const jaTemTitulos = await db.query(
        `SELECT EXISTS (
           SELECT 1
             FROM marca_condicoes_comerciais c
             JOIN receita_titulos rt ON rt.tenant_id = c.tenant_id AND rt.marca_id = c.marca_id
            WHERE c.id = $3::uuid AND c.tenant_id = $1::uuid AND c.marca_id = $2::uuid
              AND c.cancelled_at IS NULL
              AND c.comissao_janela_inicio_dia IS DISTINCT FROM $4::smallint
              AND rt.competencia >= c.inicio_vigencia
              AND rt.competencia < COALESCE((
                    SELECT MIN(n.inicio_vigencia) FROM marca_condicoes_comerciais n
                     WHERE n.tenant_id = c.tenant_id AND n.marca_id = c.marca_id
                       AND n.cancelled_at IS NULL AND n.inicio_vigencia > c.inicio_vigencia
                  ), DATE '9999-12-01')
         ) AS tem`,
        [tenantId, marcaId, condicaoId, campos.comissao_janela_inicio_dia],
      )
      if (jaTemTitulos.rows[0]?.tem) {
        throw serviceError(
          'Esta condição já tem títulos de receita gerados; alterar a janela de apuração reescreveria o passado. Crie uma nova versão da condição com início de vigência futuro.',
          'JANELA_RETROATIVA',
          400,
        )
      }
    }
    const updated = await db.query(
      `UPDATE marca_condicoes_comerciais
          SET fixo_vencimento_dia = COALESCE($4::smallint, fixo_vencimento_dia),
              fixo_vencimento_mes_offset = COALESCE($5::smallint, fixo_vencimento_mes_offset),
              comissao_vencimento_dia = COALESCE($6::smallint, comissao_vencimento_dia),
              comissao_vencimento_mes_offset = COALESCE($7::smallint, comissao_vencimento_mes_offset),
              comissao_janela_inicio_dia = COALESCE($8::smallint, comissao_janela_inicio_dia)
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND id = $3::uuid
          AND cancelled_at IS NULL
        RETURNING *`,
      [
        tenantId, marcaId, condicaoId,
        campos.fixo_vencimento_dia ?? null, campos.fixo_vencimento_mes_offset ?? null,
        campos.comissao_vencimento_dia ?? null, campos.comissao_vencimento_mes_offset ?? null,
        campos.comissao_janela_inicio_dia ?? null,
      ],
    )
    const row = updated.rows[0]
    if (!row) throw serviceError('Condição comercial não encontrada', 'CONDITION_NOT_FOUND', 404)
    // Títulos em aberto (sem baixa) da vigência desta versão: [início, próxima versão).
    await db.query(
      `UPDATE receita_titulos rt
          SET data_vencimento = ${vencimentoSql(
                'rt.competencia',
                "CASE WHEN rt.componente = 'fixo' THEN c.fixo_vencimento_dia ELSE c.comissao_vencimento_dia END",
                "CASE WHEN rt.componente = 'fixo' THEN c.fixo_vencimento_mes_offset ELSE c.comissao_vencimento_mes_offset END",
              )},
              atualizado_em = NOW()
         FROM marca_condicoes_comerciais c
        WHERE c.id = $3::uuid AND c.tenant_id = $1::uuid
          AND rt.tenant_id = $1::uuid AND rt.marca_id = $2::uuid
          AND rt.valor_pago = 0 AND rt.data_pagamento IS NULL
          AND rt.competencia >= c.inicio_vigencia
          AND rt.competencia < COALESCE((
                SELECT MIN(n.inicio_vigencia) FROM marca_condicoes_comerciais n
                 WHERE n.tenant_id = $1::uuid AND n.marca_id = $2::uuid
                   AND n.cancelled_at IS NULL AND n.inicio_vigencia > c.inicio_vigencia
              ), DATE '9999-12-01')`,
      [tenantId, marcaId, condicaoId],
    )
    await db.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, metadata)
       VALUES ($1::uuid, $2::uuid, 'marca_condicao.vencimento', 'marca_condicao', $3::uuid, $4::jsonb)`,
      [tenantId, actorUserId ?? null, condicaoId, JSON.stringify({ marca_id: marcaId, ...campos })],
    )
    await db.query('COMMIT')
    return conditionRowToPublic(row)
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export const createMarcaCondicao = confirmarCondicaoMarca
export const previewMarcaCondicao = preverCondicaoMarca
