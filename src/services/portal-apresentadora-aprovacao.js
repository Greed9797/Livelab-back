import { calcularComissoesDaLive } from './commission-engine.js'
import { calcularComissaoApresentadora } from './comissao.js'
import { comissaoValorFromPct, resolveComissaoPctSemCabine } from '../lib/comissao-sem-cabine.js'
import { seedRateioPlanejado } from '../lib/agenda-turnos.js'
import { syncAgendaEventForLive } from '../lib/live-agenda-sync.js'
import { recalcularVendasAtribuidasApresentadora } from '../routes/vendas_atribuidas.js'
import { saoPauloDateInput } from '../lib/timezone.js'
import { marcaStatusOperacionalSql } from '../lib/entity-status.js'
import { pendingCollisionSql } from '../lib/presenter-pending.js'

export const CONFLITO_HORARIO = 'conflito_horario'

export function conflitoHorarioError(message) {
  const error = new Error(message)
  error.statusCode = 409
  error.code = CONFLITO_HORARIO
  return error
}

export function isConflitoHorarioError(error) {
  return error?.code === CONFLITO_HORARIO
}

export function submissionTimesAreApprovable({ iniciado_em, encerrado_em }, now = new Date()) {
  const start = new Date(iniciado_em)
  const end = new Date(encerrado_em)
  return Number.isFinite(start.valueOf()) && Number.isFinite(end.valueOf()) && end > start && end <= now && (end - start) <= 24 * 60 * 60 * 1000
}

export function oficialPayloadFromSubmission(submissao) {
  return {
    marca_id: submissao.marca_id,
    iniciado_em: submissao.iniciado_em,
    encerrado_em: submissao.encerrado_em,
    gmv_oficial: submissao.gmv_declarado,
    pedidos_oficiais: submissao.pedidos_declarados,
    live_impressions_oficiais: submissao.live_impressions_declaradas ?? null,
    manual_views_oficiais: submissao.manual_views_declaradas ?? null,
  }
}

/**
 * Aprova uma submissão criando live oficial (sem vínculo) ou vinculando live_id.
 * Deve rodar dentro de withPortalPresenterDb. Lança Error com statusCode.
 */
export async function aprovarSubmissaoComOficial(db, {
  tenantId,
  revisorId,
  submissionId,
  parsed,
  recordHistory,
  deferMonthRecalc = false,
}) {
  const sub = await db.query(`SELECT * FROM apresentadora_live_submissoes WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE`, [submissionId, tenantId])
  if (!sub.rows[0]) {
    const error = new Error('Submissão não encontrada ou já revisada.')
    error.statusCode = 409
    throw error
  }
  if (sub.rows[0].status === 'aprovada' && parsed.live_id === sub.rows[0].live_oficial_id) {
    return { id: sub.rows[0].id, status: sub.rows[0].status, live_oficial_id: sub.rows[0].live_oficial_id, revisado_em: sub.rows[0].revisado_em }
  }
  if (!['pendente', 'devolvida'].includes(sub.rows[0].status)) {
    const error = new Error('Submissão não encontrada ou já revisada.')
    error.statusCode = 409
    throw error
  }
  if (sub.rows[0].arquivamento_status) {
    const error = new Error('Aguarde a resposta da apresentadora à solicitação de arquivamento.')
    error.statusCode = 409
    throw error
  }
  if (parsed.versao_esperada !== undefined && parsed.versao_esperada !== sub.rows[0].versao) {
    const error = new Error('O envio foi alterado. Atualize a lista e confira os dados novamente.')
    error.statusCode = 409
    throw error
  }
  if (sub.rows[0].status === 'devolvida' && (parsed.versao_esperada === undefined || !parsed.motivo_revisao)) {
    const error = new Error('Para validar um envio devolvido, confira a versão atual e informe o motivo da revisão.')
    error.statusCode = 422
    throw error
  }
  let liveId = parsed.live_id
  if (liveId) {
    const linked = await db.query(`SELECT id FROM apresentadora_live_submissoes WHERE tenant_id=$1::uuid AND apresentadora_id=$3::uuid AND live_oficial_id=$2::uuid FOR UPDATE`, [tenantId, liveId, sub.rows[0].apresentadora_id])
    if (linked.rows[0]) {
      const error = new Error('A live oficial já está vinculada a outra submissão.')
      error.statusCode = 409
      throw error
    }
    const allowed = await db.query(`SELECT 1 FROM lives l JOIN apresentadoras a ON a.id=$3::uuid AND a.tenant_id=l.tenant_id WHERE l.id=$1::uuid AND l.tenant_id=$2::uuid AND l.status='encerrada' AND l.uniao_destino_id IS NULL AND l.uniao_desfeita_em IS NULL AND l.marca_id=$4::uuid AND (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date=(($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date) AND (l.apresentador_id=a.user_id OR EXISTS (SELECT 1 FROM live_apresentadores la WHERE la.live_id=l.id AND la.tenant_id=l.tenant_id AND la.apresentador_id=a.user_id) OR EXISTS (SELECT 1 FROM live_apresentadoras_v2 lav WHERE lav.live_id=l.id AND lav.tenant_id=l.tenant_id AND lav.apresentadora_id=a.id)) FOR UPDATE OF l LIMIT 1`, [liveId, tenantId, sub.rows[0].apresentadora_id, sub.rows[0].marca_id, sub.rows[0].iniciado_em])
    if (!allowed.rows[0]) {
      const error = new Error('A live oficial precisa ser da mesma marca, dia e apresentadora, e estar encerrada.')
      error.statusCode = 422
      throw error
    }
  } else {
    if (!parsed.marca_id || parsed.gmv_oficial == null || parsed.pedidos_oficiais == null || !submissionTimesAreApprovable(parsed)) {
      const error = new Error('Para criar a live oficial, informe marca, início, fim, GMV e pedidos conferidos pela gestão.')
      error.statusCode = 422
      throw error
    }
    parsed.live_impressions_oficiais ??= sub.rows[0].live_impressions_declaradas ?? null
    parsed.manual_views_oficiais ??= sub.rows[0].manual_views_declaradas ?? null
    liveId = await criarLiveOficialDaSubmissao(db, { tenantId, revisorId, submissao: sub.rows[0], oficial: parsed, deferMonthRecalc })
  }
  const createdOfficial = !parsed.live_id
  const updated = await db.query(`UPDATE apresentadora_live_submissoes SET status='aprovada',live_oficial_id=$4::uuid,revisado_por=$3::uuid,revisado_em=NOW(),atualizado_em=NOW(),live_impressions_oficiais=CASE WHEN $5::boolean THEN $6::bigint ELSE live_impressions_oficiais END,manual_views_oficiais=CASE WHEN $5::boolean THEN $7::int ELSE manual_views_oficiais END WHERE id=$1::uuid AND tenant_id=$2::uuid AND status IN ('pendente','devolvida') RETURNING id,status,live_oficial_id,revisado_em`, [submissionId, tenantId, revisorId, liveId, createdOfficial, parsed.live_impressions_oficiais ?? null, parsed.manual_views_oficiais ?? null])
  if (!updated.rows[0]) {
    const error = new Error('Submissão já aprovada.')
    error.statusCode = 409
    throw error
  }
  await recordHistory(db, { tenantId, submissionId: updated.rows[0].id, version: sub.rows[0].versao, action: 'aprovada', actorId: revisorId, motivo: parsed.motivo_revisao ?? null })
  return updated.rows[0]
}

// Materializa um relato APROVADO dentro da transação do revisor. Não aceita
// A identidade vem da submissão bloqueada; os valores oficiais foram conferidos
// pelo gestor. Os mesmos helpers do registro manual mantêm agenda/rateio/comissão.
export async function criarLiveOficialDaSubmissao(db, { tenantId, revisorId, submissao, oficial, deferMonthRecalc = false }) {
  const cabineId = oficial.cabine_id ?? null

  // Sem cabine não há linha de cabine para travar. FOR UPDATE em marcas estoura
  // 42501: a role do portal só tem SELECT nessa tabela
  // ("permission denied for table marcas") e o aprovar vira HTTP 500.
  // O lock de transação serializa dois envios da mesma apresentadora.
  if (!cabineId) {
    await db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`live-approve:${tenantId}:${submissao.apresentadora_id}`],
    )
  }

  const refs = cabineId
    ? await db.query(`SELECT m.cliente_id, m.tipo, a.user_id, a.comissao_pct AS apresentadora_pct,
        cl.status AS cliente_status, ct.comissao_pct AS contrato_pct
      FROM marcas m JOIN apresentadoras a ON a.id=$3::uuid AND a.tenant_id=m.tenant_id
      JOIN cabines c ON c.id=$4::uuid AND c.tenant_id=m.tenant_id AND c.ativo IS DISTINCT FROM FALSE
      JOIN users u ON u.id=a.user_id AND u.tenant_id=a.tenant_id AND u.ativo IS TRUE
      LEFT JOIN clientes cl ON cl.id=m.cliente_id AND cl.tenant_id=m.tenant_id
      LEFT JOIN contratos ct ON ct.id=c.contrato_id AND ct.tenant_id=c.tenant_id AND ct.status='ativo'
      WHERE m.id=$2::uuid AND m.tenant_id=$1::uuid AND ${marcaStatusOperacionalSql('m', 'cl')}='ativa'
        AND a.ativo IS TRUE AND a.arquivada IS DISTINCT FROM TRUE
        AND (m.cliente_id IS NULL OR cl.id IS NOT NULL)
        AND (c.contrato_id IS NULL OR EXISTS (SELECT 1 FROM contratos x WHERE x.id=c.contrato_id AND x.tenant_id=c.tenant_id))
      FOR UPDATE OF c`, [tenantId, oficial.marca_id, submissao.apresentadora_id, cabineId])
    : await db.query(`SELECT m.cliente_id, m.tipo, a.user_id, a.comissao_pct AS apresentadora_pct,
        cl.status AS cliente_status, NULL::numeric AS contrato_pct
      FROM marcas m JOIN apresentadoras a ON a.id=$3::uuid AND a.tenant_id=m.tenant_id
      JOIN users u ON u.id=a.user_id AND u.tenant_id=a.tenant_id AND u.ativo IS TRUE
      LEFT JOIN clientes cl ON cl.id=m.cliente_id AND cl.tenant_id=m.tenant_id
      WHERE m.id=$2::uuid AND m.tenant_id=$1::uuid AND ${marcaStatusOperacionalSql('m', 'cl')}='ativa'
        AND a.ativo IS TRUE AND a.arquivada IS DISTINCT FROM TRUE
        AND (m.cliente_id IS NULL OR cl.id IS NOT NULL)`, [tenantId, oficial.marca_id, submissao.apresentadora_id])

  const ref = refs.rows[0]
  if (!ref) {
    const error = new Error(cabineId
      ? 'Marca, cabine ou apresentadora não é válida para esta unidade.'
      : 'Marca ou apresentadora não é válida para esta unidade.')
    error.statusCode = 422
    throw error
  }
  const tipo = ref.tipo === 'afiliada' ? 'afiliado' : 'cliente'
  if ((tipo === 'cliente' && !ref.cliente_id) || ref.cliente_status === 'inadimplente') {
    const error = new Error('Confira o vínculo e a situação do cliente antes de aprovar.')
    error.statusCode = 422
    throw error
  }

  const gmv = Number(oficial.gmv_oficial)
  const pedidos = Number(oficial.pedidos_oficiais)

  if (cabineId) {
    const conflict = await db.query(`SELECT id FROM lives WHERE tenant_id=$1::uuid AND cabine_id=$2::uuid
      AND uniao_destino_id IS NULL AND uniao_desfeita_em IS NULL
      AND status <> 'cancelada' AND iniciado_em < $4::timestamptz
      AND COALESCE(encerrado_em,previsto_fim,'infinity'::timestamptz) > $3::timestamptz LIMIT 1`,
    [tenantId, cabineId, oficial.iniciado_em, oficial.encerrado_em])
    if (conflict.rows[0]) {
      throw conflitoHorarioError('Já existe uma live nesse horário e cabine. Confira o registro e use Vincular live existente.')
    }
  } else if (ref.user_id) {
    const conflict = await db.query(`SELECT id FROM lives WHERE tenant_id=$1::uuid AND apresentador_id=$2::uuid
      AND uniao_destino_id IS NULL AND uniao_desfeita_em IS NULL
      AND status <> 'cancelada' AND iniciado_em < $4::timestamptz
      AND COALESCE(encerrado_em,previsto_fim,'infinity'::timestamptz) > $3::timestamptz LIMIT 1`,
    [tenantId, ref.user_id, oficial.iniciado_em, oficial.encerrado_em])
    if (conflict.rows[0]) {
      throw conflitoHorarioError('Já existe uma live oficial desta apresentadora neste horário. Confira o registro e use Vincular live existente.')
    }
  }

  let comissaoFranquia = null
  if (cabineId) {
    const pctContrato = ref.contrato_pct == null ? null : Number(ref.contrato_pct)
    comissaoFranquia = pctContrato == null ? null : gmv * (pctContrato / 100)
  } else {
    const pct = await resolveComissaoPctSemCabine(db, {
      tenantId,
      marcaId: oficial.marca_id,
      apresentadoraId: submissao.apresentadora_id,
      gmv,
      data: saoPauloDateInput(oficial.iniciado_em),
    })
    comissaoFranquia = comissaoValorFromPct(gmv, pct)
  }

  const snapshot = calcularComissaoApresentadora({
    fatGerado: gmv,
    apresentadoraPct: ref.apresentadora_pct == null ? null : Number(ref.apresentadora_pct),
    iniciadoEm: oficial.iniciado_em,
    temApresentadora: true,
  })
  const created = await db.query(`INSERT INTO lives (tenant_id,cabine_id,cliente_id,apresentador_id,gestor_id,status,iniciado_em,encerrado_em,fat_gerado,final_orders_count,live_impressions,manual_views,resumo,tipo,status_publicacao,origem_dados,marca_id,comissao_calculada,comissao_apresentadora_pct,comissao_apresentadora_valor)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'encerrada',$6::timestamptz,$7::timestamptz,$8::numeric,$9::int,$10::bigint,$11::int,$12,$14,'revisado','apresentadora',$13::uuid,$15,$16,$17) RETURNING id`,
  [tenantId, cabineId, ref.cliente_id, ref.user_id, revisorId, oficial.iniciado_em, oficial.encerrado_em, gmv, pedidos, oficial.live_impressions_oficiais ?? null, oficial.manual_views_oficiais ?? null, submissao.observacao ?? null, oficial.marca_id, tipo, comissaoFranquia, snapshot.pct, snapshot.valor])
  const liveId = created.rows[0].id
  const agendaId = await syncAgendaEventForLive(db, {
    tenantId,
    liveId,
    cabineId,
    marcaId: oficial.marca_id,
    apresentadoraId: submissao.apresentadora_id,
    dataInicio: oficial.iniciado_em,
    dataFim: oficial.encerrado_em,
    status: 'encerrada',
    observacoes: submissao.observacao,
    criadoPor: revisorId,
  })
  await seedRateioPlanejado(db, {
    tenantId,
    liveId,
    agendaEventoId: agendaId,
    apresentadoraFallbackId: submissao.apresentadora_id,
    apresentadoraConfirmadaId: submissao.apresentadora_id,
  })
  const sales = await calcularComissoesDaLive(db, { liveId, tenantId, gmv, pedidos, retroLift: false })
  // O lote aprova ~20 lives. Recalcular o mês inteiro em cada uma repetia a mesma
  // escada (a importação já adia isso: 9 linhas levavam 177s). O lote chama o
  // retro-lift uma vez por apresentadora, depois que cada live já commitou.
  if (!deferMonthRecalc) {
    for (const apresentadoraId of new Set(sales.map(row => row.apresentadora_id).filter(Boolean))) {
      await recalcularVendasAtribuidasApresentadora(db, {
        tenantId,
        apresentadoraId,
        mesReferencia: saoPauloDateInput(oficial.iniciado_em).slice(0, 7),
      })
    }
  }
  // O motor trata percentual ausente como 0. Sem cabine isso gravaria comissão
  // inventada por cima do valor (ou do NULL) resolvido acima.
  if (!cabineId) await manterComissaoFranquiaSemCabine(db, { tenantId, liveId, comissaoFranquia })
  return liveId
}

async function manterComissaoFranquiaSemCabine(db, { tenantId, liveId, comissaoFranquia }) {
  if (comissaoFranquia == null) {
    await db.query(
      `UPDATE lives SET comissao_calculada = NULL
        WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [liveId, tenantId],
    )
    await db.query(
      `UPDATE vendas_atribuidas SET comissao_franquia = NULL
        WHERE tenant_id = $1::uuid AND origem = 'live' AND origem_id = $2::uuid`,
      [tenantId, liveId],
    )
    return
  }

  const zeros = await db.query(
    `SELECT id FROM vendas_atribuidas
      WHERE tenant_id = $1::uuid AND origem = 'live' AND origem_id = $2::uuid
        AND comissao_franquia = 0`,
    [tenantId, liveId],
  )
  if (zeros.rows.length !== 1) return
  await db.query(
    `UPDATE vendas_atribuidas SET comissao_franquia = $3
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [zeros.rows[0].id, tenantId, comissaoFranquia],
  )
  await db.query(
    `UPDATE lives SET comissao_calculada = $3
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND comissao_calculada = 0`,
    [liveId, tenantId, comissaoFranquia],
  )
}

const MSG_CONFLITO_APRESENTADORA = 'Já existe uma live oficial desta apresentadora neste horário. Confira o registro e use Vincular live existente.'
const MSG_CONFLITO_MARCA = 'Conflito de horário com outra live ou envio da mesma marca.'

// Mesma recusa da aprovação sem cabine (sobreposição da apresentadora) e a
// mesma marcação que a lista já mostra como "Em conciliação" (pendingCollisionSql).
export async function motivoConflitoAprovacaoSemCabine(db, { tenantId, submissionId }) {
  const result = await db.query(
    `SELECT ${pendingCollisionSql('s')} AS em_conciliacao,
            EXISTS (
              SELECT 1 FROM lives l
              JOIN apresentadoras a ON a.id = s.apresentadora_id AND a.tenant_id = s.tenant_id
              WHERE l.tenant_id = s.tenant_id
                AND a.user_id IS NOT NULL
                AND l.apresentador_id = a.user_id
                AND l.uniao_destino_id IS NULL
                AND l.uniao_desfeita_em IS NULL
                AND l.status <> 'cancelada'
                AND l.iniciado_em < s.encerrado_em
                AND COALESCE(l.encerrado_em, l.previsto_fim, 'infinity'::timestamptz) > s.iniciado_em
            ) AS conflito_apresentadora
       FROM apresentadora_live_submissoes s
      WHERE s.id = $1::uuid AND s.tenant_id = $2::uuid`,
    [submissionId, tenantId],
  )
  const row = result.rows[0]
  if (!row) return null
  if (row.conflito_apresentadora === true) return MSG_CONFLITO_APRESENTADORA
  if (row.em_conciliacao === true) return MSG_CONFLITO_MARCA
  return null
}

function describeSubmission(row) {
  return {
    id: row.id,
    apresentadora_nome: row.apresentadora_nome ?? null,
    marca_nome: row.marca_nome ?? null,
    iniciado_em: row.iniciado_em ?? null,
  }
}

function byInicio(a, b) {
  const ta = new Date(a.iniciado_em).getTime()
  const tb = new Date(b.iniciado_em).getTime()
  if (ta !== tb) return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
  return String(a.id).localeCompare(String(b.id))
}

/**
 * Aprova cada envio na própria transação. Conflito vira skipped_conflito.
 * Uma falha não desfaz os que já commitou. Não grava comissão inventada:
 * o insert continua em aprovarSubmissaoComOficial / criarLiveOficialDaSubmissao.
 */
function linhaProntaParaAprovar(row, normalizeOfficialMetrics) {
  const described = describeSubmission(row)
  if (row.status !== 'pendente') return { described, skip: 'Envio não está pendente.' }
  if (row.arquivamento_status) return { described, skip: 'Aguardando resposta de arquivamento.' }
  const normalized = normalizeOfficialMetrics(oficialPayloadFromSubmission(row))
  if (!normalized?.data) return { described, skip: normalized?.error ?? 'Dados inválidos.' }
  const oficial = normalized.data
  if (!oficial.marca_id || oficial.gmv_oficial == null || oficial.pedidos_oficiais == null || !submissionTimesAreApprovable(oficial)) {
    return { described, skip: 'Dados incompletos ou horário inválido para aprovação automática.' }
  }
  return { described, oficial }
}

export async function aprovarPendentesSemConflito({
  rows,
  tenantId,
  revisorId,
  recordHistory,
  normalizeOfficialMetrics,
  runInDb,
  session,
  approve = aprovarSubmissaoComOficial,
  conflict = motivoConflitoAprovacaoSemCabine,
  recalculateMonth,
}) {
  const approved = []
  const skipped = []
  const skipped_conflito = []
  const failed = []
  const actionable = []

  for (const row of [...rows].sort(byInicio)) {
    const ready = linhaProntaParaAprovar(row, normalizeOfficialMetrics)
    if (ready.skip) {
      skipped.push({ ...ready.described, reason: ready.skip })
      continue
    }
    actionable.push({ row, described: ready.described, oficial: ready.oficial })
  }

  if (session) {
    const { aprovarLoteNaSessao } = await import('./portal-aprovacao-lote.js')
    await aprovarLoteNaSessao({
      actionable,
      tenantId,
      revisorId,
      recordHistory,
      session,
      approve,
      ...(recalculateMonth ? { recalculateMonth } : {}),
      buckets: { approved, skipped, skipped_conflito, failed },
    })
    return { approved, skipped, skipped_conflito, failed }
  }

  for (const { row, described, oficial } of actionable) {
    try {
      const outcome = await runInDb(async (db) => {
        const reason = await conflict(db, { tenantId, submissionId: row.id })
        if (reason) return { conflito: reason }
        const result = await approve(db, {
          tenantId,
          revisorId,
          submissionId: row.id,
          parsed: oficial,
          recordHistory,
        })
        return { result }
      })
      if (outcome?.conflito) {
        const item = { ...described, reason: outcome.conflito }
        skipped_conflito.push(item)
        skipped.push({ ...item, conflito: true })
        continue
      }
      approved.push({ ...described, live_oficial_id: outcome.result.live_oficial_id })
    } catch (error) {
      if (isConflitoHorarioError(error)) {
        const item = { ...described, reason: error.message }
        skipped_conflito.push(item)
        skipped.push({ ...item, conflito: true })
        continue
      }
      failed.push({ ...described, error: error?.message ?? 'Erro ao aprovar envio.' })
    }
  }

  return { approved, skipped, skipped_conflito, failed }
}
