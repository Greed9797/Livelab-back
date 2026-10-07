import { createHash } from 'node:crypto'
import { normalizarMarcaCondicao } from '../lib/marca-condicoes.js'
import { lockTenantLiveFinance } from '../lib/live-finance-lock.js'
import { reconcileCondicaoReceitas } from './competencias-receitas.js'
import {
  conditionRowToPublic, ensureIds, listRows, lockMarca, normalizeRevision,
  previewInTransaction, proposalToPublic, readImpact, recalculateOpenLives,
  recalculateOpenVendas, serviceError,
} from './marca-condicoes.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EDIT_FIELDS = new Set(['inicio_vigencia', 'competencia', 'fixo_mensal', 'comissao_franquia_pct',
  'comissao_franqueadora_pct', 'tipo_cobranca', 'fixo_confirmado', 'comissao_confirmada',
  'fixo_vencimento_dia', 'fixo_vencimento_mes_offset', 'comissao_vencimento_dia',
  'comissao_vencimento_mes_offset', 'comissao_janela_inicio_dia', 'motivo', 'expected_revision', 'origem'])

function validateRequest(options, previewOnly) {
  ensureIds(options)
  if (![options.tenantId, options.marcaId, options.condicaoId].every(id => UUID_RE.test(id ?? ''))) {
    throw serviceError('Condição comercial não encontrada', 'CONDITION_NOT_FOUND', 404)
  }
  if (!['editar', 'excluir'].includes(options.operacao)) {
    throw serviceError('Operação inválida', 'INVALID_OPERATION', 400)
  }
  const motivo = typeof options.motivo === 'string' ? options.motivo.trim() : ''
  if (!motivo || motivo.length > 255) throw serviceError('Informe um motivo de até 255 caracteres', 'REASON_REQUIRED', 400)
  const proposta = options.proposta ?? {}
  if (proposta === null || typeof proposta !== 'object' || Array.isArray(proposta)
    || Object.keys(proposta).some(key => !EDIT_FIELDS.has(key))) {
    throw serviceError('Campos da condição inválidos', 'INVALID_MARCA_CONDITION', 400)
  }
  for (const field of ['fixo_confirmado', 'comissao_confirmada']) {
    if (field in proposta && typeof proposta[field] !== 'boolean') throw serviceError(`${field} deve ser booleano`, 'INVALID_MARCA_CONDITION', 400)
  }
  if (!previewOnly) {
    normalizeRevision(options.expectedRevision)
    if (typeof options.idempotencyKey !== 'string' || !options.idempotencyKey.trim() || options.idempotencyKey.length > 255) {
      throw serviceError('Idempotency-Key é obrigatório', 'IDEMPOTENCY_KEY_REQUIRED', 400)
    }
  }
  return { ...options, proposta, motivo }
}

// Canonical request fingerprint is independent of the mutable condition values.
function requestHash(options) {
  const entries = Object.entries(options.proposta).filter(([key]) => !['expected_revision', 'motivo'].includes(key)).sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256').update(JSON.stringify({ operacao: options.operacao, condicaoId: options.condicaoId,
    motivo: options.motivo, proposta: Object.fromEntries(entries) })).digest('hex')
}

async function applyCondition(db, { tenantId, marcaId, condicaoId, operacao, motivo, proposal, revision }) {
  const result = operacao === 'excluir'
    ? await db.query(`UPDATE marca_condicoes_comerciais SET cancelled_at = NOW(), revision = $4, motivo = $5
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND id = $3::uuid AND cancelled_at IS NULL RETURNING *`,
      [tenantId, marcaId, condicaoId, revision, motivo])
    : await db.query(`UPDATE marca_condicoes_comerciais
        SET fixo_mensal = $4, comissao_franquia_pct = $5, comissao_franqueadora_pct = $6,
            tipo_cobranca = $7, fixo_confirmado = $8, comissao_confirmada = $9,
            fixo_vencimento_dia = $10, fixo_vencimento_mes_offset = $11,
            comissao_vencimento_dia = $12, comissao_vencimento_mes_offset = $13,
            comissao_janela_inicio_dia = $14, revision = $15, motivo = $16
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND id = $3::uuid AND cancelled_at IS NULL RETURNING *`,
      [tenantId, marcaId, condicaoId, proposal.fixo_mensal, proposal.comissao_franquia_pct,
        proposal.comissao_franqueadora_pct, proposal.tipo_cobranca, proposal.fixo_confirmado,
        proposal.comissao_confirmada, proposal.fixo_vencimento_dia, proposal.fixo_vencimento_mes_offset,
        proposal.comissao_vencimento_dia, proposal.comissao_vencimento_mes_offset,
        proposal.comissao_janela_inicio_dia, revision, motivo])
  if (!result.rows[0]) throw serviceError('Condição comercial não encontrada ou cancelada', 'CONDITION_NOT_FOUND', 404)
  return conditionRowToPublic(result.rows[0])
}

async function mutate(db, rawOptions, previewOnly) {
  const options = validateRequest(rawOptions, previewOnly)
  const { tenantId, marcaId, condicaoId, operacao, motivo, idempotencyKey, actorUserId = null } = options
  const payloadHash = requestHash(options)
  await db.query('BEGIN')
  try {
    // Same order as create; receiving only takes the second lock and title row locks.
    await lockTenantLiveFinance(db, tenantId)
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('receita_titulos:' || $1::text))`, [tenantId])
    await lockMarca(db, { tenantId, marcaId })
    if (!previewOnly) {
      const replay = await db.query(`SELECT metadata FROM audit_log
        WHERE tenant_id = $1::uuid AND entity_type = 'marca_condicao'
          AND metadata->>'marca_id' = $2 AND metadata->>'idempotency_key' = $3
          AND action IN ('marca_condicao.editar', 'marca_condicao.excluir') LIMIT 1`, [tenantId, marcaId, idempotencyKey])
      if (replay.rows[0]) {
        const metadata = replay.rows[0].metadata
        if (metadata.payload_hash !== payloadHash) throw serviceError('Idempotency-Key já utilizado', 'IDEMPOTENCY_CONFLICT', 409)
        await db.query('COMMIT')
        return { ...metadata.result, idempotent: true, recalculated: false }
      }
      const createKey = await db.query(`SELECT id FROM marca_condicoes_comerciais
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND idempotency_key = $3`, [tenantId, marcaId, idempotencyKey])
      if (createKey.rows.length) throw serviceError('Idempotency-Key já utilizado', 'IDEMPOTENCY_CONFLICT', 409)
    }
    const conditions = await listRows(db, { tenantId, marcaId })
    const currentRevision = Math.max(1, ...conditions.map(row => Number(row.revision)))
    if (!previewOnly && normalizeRevision(options.expectedRevision) !== currentRevision) {
      throw serviceError('A revisão mudou; atualize a prévia', 'STALE_REVISION', 409, { currentRevision })
    }
    const target = conditions.find(row => row.id === condicaoId && !row.cancelled_at)
    if (!target) throw serviceError('Condição comercial não encontrada ou cancelada', 'CONDITION_NOT_FOUND', 404)
    let proposal = null
    if (operacao === 'editar') {
      const incoming = options.proposta
      if ((incoming.inicio_vigencia && String(incoming.inicio_vigencia).slice(0, 7) !== target.competencia)
        || (incoming.competencia && incoming.competencia !== target.competencia)) {
        throw serviceError('O início da vigência não pode ser alterado', 'IMMUTABLE_START', 400)
      }
      proposal = proposalToPublic(normalizarMarcaCondicao({ ...target, ...incoming, inicio_vigencia: target.inicio_vigencia, motivo }))
      // A new accrual window requires a new version once titles exist; it changes the fact's month.
      if (proposal.comissao_janela_inicio_dia !== target.comissao_janela_inicio_dia) {
        const titles = await db.query(`SELECT 1 FROM receita_titulos WHERE tenant_id = $1::uuid AND marca_id = $2::uuid
          AND competencia >= $3::date AND competencia < COALESCE((SELECT MIN(inicio_vigencia)
            FROM marca_condicoes_comerciais WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND inicio_vigencia > $3::date), DATE '9999-12-01') LIMIT 1`,
        [tenantId, marcaId, target.inicio_vigencia])
        if (titles.rows.length) throw serviceError('Crie nova vigência para alterar a janela de uma condição com títulos', 'JANELA_RETROATIVA', 400)
      }
    }
    const preview = await previewInTransaction(db, { tenantId, marcaId, proposal: proposal ?? target, conditions })
    // Extend to future materialized obligations as well as open facts; canceled successors remain boundaries.
    const horizon = await db.query(`SELECT (date_trunc('month', GREATEST(COALESCE(MAX(competencia), $3::date),
      (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)) + interval '1 month')::date::text AS fim
      FROM receita_titulos WHERE tenant_id = $1::uuid AND marca_id = $2::uuid`, [tenantId, marcaId, target.inicio_vigencia])
    const next = conditions.filter(row => row.inicio_vigencia > target.inicio_vigencia).sort((a, b) => a.inicio_vigencia.localeCompare(b.inicio_vigencia))[0]
    let end = [preview.fim_vigencia_exclusivo, horizon.rows[0]?.fim].filter(Boolean).sort().at(-1)
    if (next && next.inicio_vigencia < end) end = next.inicio_vigencia
    Object.assign(preview, { operacao, expected_revision: currentRevision, condicao_anterior: target,
      proposta: proposal, fim_vigencia_exclusivo: end, bloqueada: false,
      impacto: await readImpact(db, { tenantId, marcaId, start: target.inicio_vigencia, end }) })
    const condition = await applyCondition(db, { ...options, proposal, revision: currentRevision + 1 })
    const range = { tenantId, marcaId, start: target.inicio_vigencia, end }
    await recalculateOpenVendas(db, range)
    await recalculateOpenLives(db, range)
    preview.financeiro = await reconcileCondicaoReceitas(db, { ...range, operacao, previewOnly, conditionId: condicaoId, motivo, actorUserId })
    const result = { condition, idempotent: false, recalculated: true, preview }
    if (previewOnly) {
      await db.query('ROLLBACK')
      return preview
    }
    // Current legacy projection follows the latest boundary, including a canceled zero interval.
    await db.query(`UPDATE marcas m SET valor_fixo_minimo = CASE WHEN c.cancelled_at IS NULL THEN c.fixo_mensal ELSE 0 END,
      comissao_franquia_pct = CASE WHEN c.cancelled_at IS NULL THEN c.comissao_franquia_pct ELSE 0 END,
      comissao_franqueadora_pct = CASE WHEN c.cancelled_at IS NULL THEN c.comissao_franqueadora_pct ELSE 0 END,
      tipo_cobranca = c.tipo_cobranca, atualizado_em = NOW()
      FROM (SELECT * FROM marca_condicoes_comerciais WHERE tenant_id = $1::uuid AND marca_id = $2::uuid
        AND inicio_vigencia <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
        ORDER BY inicio_vigencia DESC, revision DESC LIMIT 1) c
      WHERE m.tenant_id = $1::uuid AND m.id = $2::uuid`, [tenantId, marcaId])
    await db.query(`INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, metadata)
      VALUES ($1::uuid, $2::uuid, $3, 'marca_condicao', $4::uuid, $5::jsonb)`,
    [tenantId, actorUserId, `marca_condicao.${operacao}`, condicaoId, JSON.stringify({ marca_id: marcaId, motivo,
      idempotency_key: idempotencyKey, payload_hash: payloadHash, antes: target, result })])
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export const preverMutacaoCondicaoMarca = (db, options) => mutate(db, options, true)
export const atualizarCondicaoMarca = (db, options) => mutate(db, { ...options, operacao: 'editar' }, false)
export const excluirCondicaoMarca = (db, options) => mutate(db, { ...options, operacao: 'excluir' }, false)
