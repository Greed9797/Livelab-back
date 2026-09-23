import { z } from 'zod'
import { getOperationalRanking as getPerformanceRanking } from '../lib/operational-ranking.js'
import { monthRangeFromQuery } from '../lib/presenter-ranking.js'
import { presenterFixedSql } from '../config/presenter_defaults.js'
import {
  aprovarSubmissaoComOficial,
  oficialPayloadFromSubmission,
  submissionTimesAreApprovable,
} from '../services/portal-apresentadora-aprovacao.js'
import { getOwnPortalPerformance } from '../services/portal-apresentadora-performance.js'
import { withPortalPresenterDb } from '../services/portal-apresentadora-db.js'
import { getOwnPortalRemuneration } from '../services/portal-apresentadora-remuneracao.js'
import { marcaStatusOperacionalSql } from '../lib/entity-status.js'
import { parsePortalCount, parsePortalMoney } from '../lib/portal-submission-input.js'
import { saoPauloDateInput, saoPauloDayBounds } from '../lib/timezone.js'
import { invalidateTenant } from '../lib/dashboard-cache.js'
import { invalidateHomeDashboard } from './home.js'

const PORTAL_PAPEIS = ['apresentador', 'apresentadora']
const REVIEW_PAPEIS = ['franqueador_master', 'franqueado', 'gerente', 'operacional', 'produtor_live']
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const uuid = z.string().uuid()
const money = z.union([z.number().finite(), z.string().trim().min(1).max(32)])
const orders = z.union([z.number().finite(), z.string().trim().min(1).max(32)])
const impressions = z.union([z.number().finite(), z.string().trim().min(1).max(32)])
const views = z.union([z.number().finite(), z.string().trim().min(1).max(32)])
const submissionSchema = z.object({
  marca_id: uuid,
  cabine_id: uuid.optional(),
  iniciado_em: z.string().datetime({ offset: true }),
  encerrado_em: z.string().datetime({ offset: true }),
  observacao: z.string().trim().max(2000).optional(),
  gmv_declarado: money,
  pedidos_declarados: orders,
  live_impressions_declaradas: impressions,
  manual_views_declaradas: views,
  request_id: uuid.optional(),
}).strict()
const reviewSchema = z.object({
  versao_esperada: z.number().int().positive().optional(),
  motivo_revisao: z.string().trim().min(1).max(1000).optional(),
  live_id: uuid.optional(),
  marca_id: uuid.optional(), cabine_id: uuid.optional(),
  iniciado_em: z.string().datetime({ offset: true }).optional(),
  encerrado_em: z.string().datetime({ offset: true }).optional(),
  gmv_oficial: money.optional(),
  pedidos_oficiais: orders.optional(),
  live_impressions_oficiais: impressions.optional(),
  manual_views_oficiais: views.optional(),
}).strict()
const devolucaoSchema = z.object({ motivo: z.string().trim().min(1).max(1000), arquivar: z.boolean().optional(), versao_esperada: z.number().int().positive().optional() }).strict()
  .refine(data => !data.arquivar || data.versao_esperada !== undefined, { message: 'Atualize o envio antes de solicitar arquivamento.' })
const arquivamentoSchema = z.object({ acao: z.enum(['confirmar', 'contestar']), motivo: z.string().trim().min(1).max(1000).optional(), versao_esperada: z.number().int().positive() }).strict()
  .refine(data => data.acao !== 'contestar' || Boolean(data.motivo), { message: 'Informe o motivo da contestação.' })
const batchApproveDaySchema = z.object({ data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict()

function normalizeSubmissionMetrics(data) {
  const gmv = parsePortalMoney(data.gmv_declarado)
  if (!gmv.ok) return { error: gmv.error, field: 'gmv_declarado' }
  const pedidos = parsePortalCount(data.pedidos_declarados, 2147483647)
  if (!pedidos.ok) return { error: pedidos.error, field: 'pedidos_declarados' }
  const normalized = { ...data, gmv_declarado: gmv.value, pedidos_declarados: pedidos.value }
  for (const [field, max] of [['live_impressions_declaradas', Number.MAX_SAFE_INTEGER], ['manual_views_declaradas', 2147483647]]) {
    if (data[field] === undefined) continue
    const count = parsePortalCount(data[field], max)
    if (!count.ok) return { error: count.error, field }
    normalized[field] = count.value
  }
  return { data: normalized }
}

function normalizeOfficialMetrics(data) {
  const normalized = { ...data }
  if (data.gmv_oficial !== undefined) {
    const gmv = parsePortalMoney(data.gmv_oficial)
    if (!gmv.ok) return { error: gmv.error, field: 'gmv_oficial' }
    normalized.gmv_oficial = gmv.value
  }
  for (const [field, max] of [['pedidos_oficiais', 2147483647], ['live_impressions_oficiais', Number.MAX_SAFE_INTEGER], ['manual_views_oficiais', 2147483647]]) {
    if (data[field] === undefined) continue
    const count = parsePortalCount(data[field], max)
    if (!count.ok) return { error: count.error, field }
    normalized[field] = count.value
  }
  return { data: normalized }
}

function ownProfile(db, tenantId, userId, papel) {
  return db.query(
    `SELECT a.id, a.nome, a.foto_url, ${presenterFixedSql('a')} AS fixo
       FROM apresentadoras a
       JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1::uuid AND a.user_id = $2::uuid
        AND a.ativo IS DISTINCT FROM FALSE AND a.arquivada IS DISTINCT FROM TRUE AND u.ativo IS TRUE AND u.papel = $3
      LIMIT 2`,
    [tenantId, userId, papel],
  )
}

async function resolveOwnProfile(db, tenantId, userId, papel) {
  const result = await ownProfile(db, tenantId, userId, papel)
  if (result.rows.length !== 1) return null
  return result.rows[0]
}

function recordHistory(db, { tenantId, submissionId, version, action, actorId, motivo = null }) {
  return db.query(`INSERT INTO apresentadora_live_submissao_historico (tenant_id,submissao_id,versao,acao,ator_id,motivo,snapshot)
    SELECT $1::uuid,$2::uuid,$3,$4,$5::uuid,$6,jsonb_build_object(
      'status',s.status,'marca_id',s.marca_id,'marca_descricao',s.marca_descricao,
      'cabine_id',s.cabine_id,'iniciado_em',s.iniciado_em,'encerrado_em',s.encerrado_em,
      'observacao',s.observacao,'gmv_declarado',s.gmv_declarado,'pedidos_declarados',s.pedidos_declarados,
      'live_impressions_declaradas',s.live_impressions_declaradas,'manual_views_declaradas',s.manual_views_declaradas,
      'live_impressions_oficiais',s.live_impressions_oficiais,'manual_views_oficiais',s.manual_views_oficiais,
      'live_oficial_id',s.live_oficial_id,'motivo_devolucao',s.motivo_devolucao,
      'arquivamento_status',s.arquivamento_status,'motivo_contestacao',s.motivo_contestacao,
      'revisado_por',s.revisado_por,'revisado_em',s.revisado_em)
    FROM apresentadora_live_submissoes s WHERE s.id=$2::uuid AND s.tenant_id=$1::uuid`, [tenantId, submissionId, version, action, actorId, motivo])
}
async function inSubmissionTransaction(db, work) {
  // Every portal request already has a transaction-local portal role. Keeping
  // transitions inside it avoids nested BEGIN while preserving atomic history.
  if (!db.inPortalTransaction) throw new Error('Transação isolada do portal ausente')
  return work()
}

async function requirePortalEnabled(request, reply) {
  const allowed = String(process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  if (!allowed.includes(request.user.tenant_id)) return reply.code(404).send({ error: 'Portal da apresentadora ainda não está disponível nesta unidade.' })
}

function monthOr400(query, reply) {
  const mes = query?.mes == null ? null : String(query.mes)
  if (mes != null && !MES_RE.test(mes)) {
    reply.code(400).send({ error: 'mes deve ter o formato YYYY-MM' })
    return null
  }
  return monthRangeFromQuery({ mes: mes ?? undefined })
}

function requiresPast(payload, now = new Date()) {
  return submissionTimesAreApprovable(payload, now)
}

export function requiresCurrentPortalMonth({ iniciado_em, encerrado_em }, now = new Date()) {
  if (!requiresPast({ iniciado_em, encerrado_em }, now)) return false
  const inicio = saoPauloDateInput(iniciado_em)
  const fim = saoPauloDateInput(encerrado_em)
  const hoje = saoPauloDateInput(now)
  return Boolean(inicio && fim && hoje && inicio === fim && inicio.slice(0, 7) === hoje.slice(0, 7))
}

export async function portalApresentadoraRoutes(app) {
  app.addHook('onResponse', async (request, reply) => {
    if (['POST','PATCH','DELETE'].includes(request.method) && reply.statusCode < 300 && request.user?.tenant_id) {
      invalidateTenant(request.user.tenant_id)
      invalidateHomeDashboard(request.user.tenant_id)
    }
  })
  // Personal performance, remuneration and review data must not enter a shared
  // HTTP cache. React Query is separately scoped to the authenticated account.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
  })
  const ownAccess = [app.authenticate, app.requirePapel(PORTAL_PAPEIS), requirePortalEnabled]
  const requireFreshManager = async (request, reply) => withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
    const current = await db.query(`SELECT 1 FROM users WHERE id=$1::uuid AND tenant_id=$2::uuid AND ativo IS TRUE AND papel=$3 LIMIT 1`, [request.user.sub, request.user.tenant_id, request.user.papel])
    if (!current.rows[0]) return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
  })
  const reviewAccess = [app.authenticate, app.requirePapel(REVIEW_PAPEIS), requirePortalEnabled, requireFreshManager]

  app.get('/v1/portal/apresentadora/me', { preHandler: ownAccess }, async (request, reply) => {
    const range = monthOr400(request.query, reply); if (!range) return reply
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel)
      if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      const [own, remuneracao] = await Promise.all([
        getOwnPortalPerformance(db, { tenantId: request.user.tenant_id, apresentadoraId: profile.id, range }),
        getOwnPortalRemuneration(db, { tenantId: request.user.tenant_id, apresentadoraId: profile.id, mes: range.start.slice(0, 7) }),
      ])
      const ranking = await getPerformanceRanking(db, { tenantId: request.user.tenant_id, range, limit: 50, groupBy: 'apresentadora' })
      const safeRanking = ranking.map((row, index) => ({ posicao: index + 1, apresentadora_id: row.apresentadora_id, nome: row.nome, foto_url: row.foto_url, gmv_total: row.gmv_total, gmv_lives: row.gmv_lives, horas_live: row.horas_live, gmv_por_hora: row.gmv_por_hora, total_lives: row.total_lives, pedidos: row.pedidos, pendente_aprovacao: row.pendente_aprovacao, gmv_pendente_aprovacao: row.gmv_pendente_aprovacao, em_conciliacao: row.em_conciliacao, total_provisorio: row.total_provisorio, fixo: Number(row.fixo ?? 0), comissao_variavel: Number(row.comissao_variavel ?? 0), total_recebido: Number(row.total_recebido ?? 0) }))
      return { perfil: { id: profile.id, nome: profile.nome, foto_url: profile.foto_url ?? null }, desempenho: own.desempenho, remuneracao, ranking: safeRanking }
    })
  })

  app.get('/v1/portal/apresentadora/opcoes', { preHandler: ownAccess }, async (request, reply) => withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
    const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel)
    if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
    const [marcas, cabines] = await Promise.all([
      db.query(`SELECT m.id,m.nome FROM marcas m LEFT JOIN clientes cl ON cl.id=m.cliente_id AND cl.tenant_id=m.tenant_id WHERE m.tenant_id=$1::uuid AND ${marcaStatusOperacionalSql('m', 'cl')}='ativa' ORDER BY m.nome`, [request.user.tenant_id]),
      db.query(`SELECT id,nome,numero FROM cabines WHERE tenant_id=$1::uuid AND ativo IS DISTINCT FROM FALSE ORDER BY numero,nome`, [request.user.tenant_id]),
    ])
    return { marcas: marcas.rows, cabines: cabines.rows }
  }))

  app.get('/v1/portal/apresentadora/lives', { preHandler: ownAccess }, async (request, reply) => {
    const range = monthOr400(request.query, reply); if (!range) return reply
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel)
      if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      const [items, pending] = await Promise.all([
        getOwnPortalPerformance(db, { tenantId: request.user.tenant_id, apresentadoraId: profile.id, range }),
        db.query(`SELECT s.id, s.status, s.marca_id, s.cabine_id, s.iniciado_em, s.encerrado_em, s.observacao, s.marca_descricao, s.gmv_declarado, s.pedidos_declarados, s.live_impressions_declaradas, s.manual_views_declaradas, s.live_impressions_oficiais, s.manual_views_oficiais, s.arquivamento_status, s.motivo_contestacao, s.motivo_devolucao, s.versao, s.live_oficial_id AS live_oficial_origem_id, COALESCE(origem.uniao_destino_id,s.live_oficial_id) AS live_oficial_id, s.live_oficial_excluida_id, s.live_oficial_excluida_em, m.nome AS marca_nome, c.nome AS cabine_nome
          FROM apresentadora_live_submissoes s LEFT JOIN lives origem ON origem.id=s.live_oficial_id AND origem.tenant_id=s.tenant_id LEFT JOIN marcas m ON m.id=s.marca_id AND m.tenant_id=s.tenant_id LEFT JOIN cabines c ON c.id=s.cabine_id AND c.tenant_id=s.tenant_id
          WHERE s.tenant_id=$1::uuid AND s.apresentadora_id=$2::uuid AND s.iniciado_em >= ($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND s.iniciado_em < ($4::date::timestamp AT TIME ZONE 'America/Sao_Paulo') ORDER BY s.criado_em DESC`, [request.user.tenant_id, profile.id, range.start, range.end]),
      ])
      return { items: items.items, submissoes: pending.rows.map((row) => ({ ...row, gmv_declarado: row.gmv_declarado == null ? null : Number(row.gmv_declarado), pedidos_declarados: row.pedidos_declarados == null ? null : Number(row.pedidos_declarados), live_impressions_declaradas: row.live_impressions_declaradas == null ? null : Number(row.live_impressions_declaradas), manual_views_declaradas: row.manual_views_declaradas == null ? null : Number(row.manual_views_declaradas), live_impressions_oficiais: row.live_impressions_oficiais == null ? null : Number(row.live_impressions_oficiais), manual_views_oficiais: row.manual_views_oficiais == null ? null : Number(row.manual_views_oficiais) })) }
    })
  })

  app.post('/v1/portal/apresentadora/submissoes', { preHandler: ownAccess }, async (request, reply) => {
    const parsed = submissionSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const normalized = normalizeSubmissionMetrics(parsed.data); if (!normalized.data) return reply.code(400).send({ error: normalized.error, field_errors: { [normalized.field]: normalized.error } })
    if (!requiresCurrentPortalMonth(normalized.data)) return reply.code(400).send({ error: 'Registre uma live concluída do mês atual, em um único dia.' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel)
      if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      const d = normalized.data
      const valid = await db.query(`SELECT 1 FROM marcas m LEFT JOIN clientes cl ON cl.id=m.cliente_id AND cl.tenant_id=m.tenant_id WHERE m.id=$1::uuid AND m.tenant_id=$2::uuid AND ${marcaStatusOperacionalSql('m', 'cl')}='ativa' LIMIT 1`, [d.marca_id, request.user.tenant_id])
      if (!valid.rows[0]) return reply.code(404).send({ error: 'Marca ativa não encontrada nesta unidade.' })
      if (d.cabine_id) { const valid = await db.query(`SELECT 1 FROM cabines WHERE id=$1::uuid AND tenant_id=$2::uuid AND ativo IS DISTINCT FROM FALSE LIMIT 1`, [d.cabine_id, request.user.tenant_id]); if (!valid.rows[0]) return reply.code(404).send({ error: 'Cabine não encontrada.' }) }
      return inSubmissionTransaction(db, async () => {
      const created = await db.query(`INSERT INTO apresentadora_live_submissoes (tenant_id, apresentadora_id, marca_id, cabine_id, iniciado_em, encerrado_em, observacao, gmv_declarado, pedidos_declarados, live_impressions_declaradas, manual_views_declaradas, client_request_id)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6::timestamptz,$7,$8::numeric,$9::int,$10::bigint,$11::int,$12::uuid) ON CONFLICT (tenant_id,apresentadora_id,client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING RETURNING id,status,versao`, [request.user.tenant_id, profile.id, d.marca_id, d.cabine_id ?? null, d.iniciado_em, d.encerrado_em, d.observacao ?? null, d.gmv_declarado, d.pedidos_declarados, d.live_impressions_declaradas ?? null, d.manual_views_declaradas ?? null, d.request_id ?? null])
      if (!created.rows[0] && d.request_id) {
        const existing = await db.query(`SELECT id,status,versao,marca_id,cabine_id,iniciado_em,encerrado_em,observacao,gmv_declarado,pedidos_declarados,live_impressions_declaradas,manual_views_declaradas FROM apresentadora_live_submissoes WHERE tenant_id=$1::uuid AND apresentadora_id=$2::uuid AND client_request_id=$3::uuid`, [request.user.tenant_id, profile.id, d.request_id])
        const row = existing.rows[0]
        const same = row && row.marca_id === d.marca_id && row.cabine_id === (d.cabine_id ?? null) && new Date(row.iniciado_em).toISOString() === new Date(d.iniciado_em).toISOString() && new Date(row.encerrado_em).toISOString() === new Date(d.encerrado_em).toISOString() && row.observacao === (d.observacao ?? null) && Number(row.gmv_declarado) === Number(d.gmv_declarado) && Number(row.pedidos_declarados) === Number(d.pedidos_declarados) && Number(row.live_impressions_declaradas ?? 0) === Number(d.live_impressions_declaradas ?? 0) && Number(row.manual_views_declaradas ?? 0) === Number(d.manual_views_declaradas ?? 0)
        if (!same) return reply.code(409).send({ error: 'request_id já foi usado com outra submissão.' })
        return row
      }
      await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: created.rows[0].id, version: created.rows[0].versao, action: 'criada', actorId: request.user.sub })
      reply.code(201)
      return created.rows[0]
      })
    })
  })

  app.patch('/v1/portal/apresentadora/submissoes/:id', { preHandler: ownAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); const parsed = submissionSchema.safeParse(request.body)
    if (!idCheck.success || !parsed.success) return reply.code(400).send({ error: !idCheck.success ? 'id inválido' : parsed.error.issues[0].message })
    const normalized = normalizeSubmissionMetrics(parsed.data); if (!normalized.data) return reply.code(400).send({ error: normalized.error, field_errors: { [normalized.field]: normalized.error } })
    if (!requiresCurrentPortalMonth(normalized.data)) return reply.code(400).send({ error: 'Registre uma live concluída do mês atual, em um único dia.' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel); if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      const d = normalized.data
      const valid = await db.query(`SELECT 1 FROM marcas m LEFT JOIN clientes cl ON cl.id=m.cliente_id AND cl.tenant_id=m.tenant_id WHERE m.id=$1::uuid AND m.tenant_id=$2::uuid AND ${marcaStatusOperacionalSql('m', 'cl')}='ativa' LIMIT 1`, [d.marca_id, request.user.tenant_id]); if (!valid.rows[0]) return reply.code(404).send({ error: 'Marca ativa não encontrada nesta unidade.' })
      if (d.cabine_id) { const valid = await db.query(`SELECT 1 FROM cabines WHERE id=$1::uuid AND tenant_id=$2::uuid AND ativo IS DISTINCT FROM FALSE LIMIT 1`, [d.cabine_id, request.user.tenant_id]); if (!valid.rows[0]) return reply.code(404).send({ error: 'Cabine não encontrada.' }) }
      return inSubmissionTransaction(db, async () => { const updated = await db.query(`UPDATE apresentadora_live_submissoes SET marca_id=$4::uuid,marca_descricao=NULL,cabine_id=$5::uuid,iniciado_em=$6::timestamptz,encerrado_em=$7::timestamptz,observacao=$8,gmv_declarado=$9::numeric,pedidos_declarados=$10::int,live_impressions_declaradas=$11::bigint,manual_views_declaradas=$12::int,atualizado_em=NOW(),versao=versao+1 WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid AND status='devolvida' AND arquivamento_status IS NULL RETURNING id,status,versao`, [idCheck.data, request.user.tenant_id, profile.id, d.marca_id, d.cabine_id ?? null, d.iniciado_em, d.encerrado_em, d.observacao ?? null, d.gmv_declarado, d.pedidos_declarados, d.live_impressions_declaradas ?? null, d.manual_views_declaradas ?? null])
      if (!updated.rows[0]) return reply.code(404).send({ error: 'Submissão não encontrada ou não pode ser alterada.' }); await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: updated.rows[0].id, version: updated.rows[0].versao, action: 'editada', actorId: request.user.sub }); return updated.rows[0]
      })
    })
  })

  app.post('/v1/portal/apresentadora/submissoes/:id/reenviar', { preHandler: ownAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); if (!idCheck.success) return reply.code(400).send({ error: 'id inválido' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel); if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      return inSubmissionTransaction(db, async () => {
      const current = await db.query(`SELECT iniciado_em,encerrado_em,marca_id,gmv_declarado,pedidos_declarados,live_impressions_declaradas,manual_views_declaradas,observacao FROM apresentadora_live_submissoes WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid AND status='devolvida' AND arquivamento_status IS NULL FOR UPDATE`, [idCheck.data, request.user.tenant_id, profile.id])
      if (!current.rows[0]) return reply.code(404).send({ error: 'Submissão não encontrada ou não pode ser reenviada.' })
      if (!requiresCurrentPortalMonth(current.rows[0]) || !current.rows[0].marca_id || current.rows[0].gmv_declarado == null || current.rows[0].pedidos_declarados == null || current.rows[0].live_impressions_declaradas == null || current.rows[0].manual_views_declaradas == null) {
        return reply.code(400).send({ error: 'Corrija todos os campos obrigatórios e registre uma live concluída do mês atual, em um único dia.' })
      }
      const result = await db.query(`UPDATE apresentadora_live_submissoes SET status='pendente',motivo_devolucao=NULL,atualizado_em=NOW(),versao=versao+1 WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid AND status='devolvida' AND arquivamento_status IS NULL RETURNING id,status,versao`, [idCheck.data, request.user.tenant_id, profile.id])
      if (!result.rows[0]) return reply.code(404).send({ error: 'Submissão não encontrada ou não pode ser reenviada.' }); await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: result.rows[0].id, version: result.rows[0].versao, action: 'reenviada', actorId: request.user.sub }); return result.rows[0]
      })
    })
  })

  app.post('/v1/portal/apresentadora/submissoes/:id/arquivamento', { preHandler: ownAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id)
    const parsed = arquivamentoSchema.safeParse(request.body)
    if (!idCheck.success || !parsed.success) return reply.code(400).send({ error: !idCheck.success ? 'id inválido' : parsed.error.issues[0].message })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel)
      if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      return inSubmissionTransaction(db, async () => {
        const current = await db.query(`SELECT status,arquivamento_status,versao FROM apresentadora_live_submissoes WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid FOR UPDATE`, [idCheck.data, request.user.tenant_id, profile.id])
        const row = current.rows[0]
        if (!row) return reply.code(404).send({ error: 'Submissão não encontrada.' })
        if (row.status !== 'devolvida' || row.arquivamento_status !== 'solicitado' || row.versao !== parsed.data.versao_esperada) return reply.code(409).send({ error: 'O envio foi alterado. Atualize a lista antes de responder.' })
        const contest = parsed.data.acao === 'contestar'
        // Responding to an existing review is not a new registration: retain its
        // real dates, including after a month boundary. Never accept metric edits here.
        const result = await db.query(`UPDATE apresentadora_live_submissoes SET status=$4,arquivamento_status=$5,motivo_contestacao=$6,versao=versao+1,atualizado_em=NOW() WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid RETURNING id,status,arquivamento_status,motivo_contestacao,versao`, [idCheck.data, request.user.tenant_id, profile.id, contest ? 'pendente' : 'cancelada', contest ? null : 'confirmado', contest ? parsed.data.motivo : null])
        await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: idCheck.data, version: result.rows[0].versao, action: contest ? 'reenviada' : 'cancelada', actorId: request.user.sub, motivo: contest ? parsed.data.motivo : 'Arquivamento confirmado pela apresentadora.' })
        return result.rows[0]
      })
    })
  })

  app.delete('/v1/portal/apresentadora/submissoes/:id', { preHandler: ownAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); if (!idCheck.success) return reply.code(400).send({ error: 'id inválido' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel); if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      return inSubmissionTransaction(db, async () => {
        const row = await db.query(`UPDATE apresentadora_live_submissoes SET status='cancelada',atualizado_em=NOW(),versao=versao+1 WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid AND status='devolvida' AND arquivamento_status IS NULL RETURNING id,status,versao`, [idCheck.data, request.user.tenant_id, profile.id])
        if (!row.rows[0]) return reply.code(404).send({ error: 'Submissão não encontrada ou não pode ser cancelada.' })
        await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: row.rows[0].id, version: row.rows[0].versao, action: 'cancelada', actorId: request.user.sub })
        return { ok: true, ...row.rows[0] }
      })
    })
  })

  app.get('/v1/lives/submissoes-apresentadoras', { preHandler: reviewAccess }, async (request, reply) => {
    const status = request.query?.status == null ? 'pendente' : String(request.query.status)
    if (!['pendente', 'devolvida', 'aprovada', 'cancelada', 'all'].includes(status)) return reply.code(400).send({ error: 'status inválido' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const rows = await db.query(`SELECT s.*,a.nome AS apresentadora_nome,m.nome AS marca_nome,c.nome AS cabine_nome FROM apresentadora_live_submissoes s JOIN apresentadoras a ON a.id=s.apresentadora_id AND a.tenant_id=s.tenant_id LEFT JOIN marcas m ON m.id=s.marca_id AND m.tenant_id=s.tenant_id LEFT JOIN cabines c ON c.id=s.cabine_id AND c.tenant_id=s.tenant_id WHERE s.tenant_id=$1::uuid AND ($2='all' OR s.status=$2) AND ($2='all' OR s.arquivamento_status IS NULL) ORDER BY s.criado_em ASC`, [request.user.tenant_id, status])
      return { items: rows.rows.map((row) => ({ ...row, gmv_declarado: row.gmv_declarado == null ? null : Number(row.gmv_declarado), pedidos_declarados: row.pedidos_declarados == null ? null : Number(row.pedidos_declarados), live_impressions_declaradas: row.live_impressions_declaradas == null ? null : Number(row.live_impressions_declaradas), manual_views_declaradas: row.manual_views_declaradas == null ? null : Number(row.manual_views_declaradas), live_impressions_oficiais: row.live_impressions_oficiais == null ? null : Number(row.live_impressions_oficiais), manual_views_oficiais: row.manual_views_oficiais == null ? null : Number(row.manual_views_oficiais) })) }
    })
  })

  // The picker is deliberately scoped on the server. A crafted live_id still goes
  // through the same check in /aprovar, but this prevents the UI from suggesting a
  // live of another brand/day/presenter in the first place.
  app.get('/v1/lives/submissoes-apresentadoras/:id/candidatas-vinculo', { preHandler: reviewAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id)
    if (!idCheck.success) return reply.code(400).send({ error: 'id inválido' })
    const page = Number(request.query?.page ?? 0)
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) return reply.code(400).send({ error: 'Página inválida.' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const sub = await db.query(`SELECT id,marca_id,apresentadora_id,iniciado_em FROM apresentadora_live_submissoes WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='pendente' LIMIT 1`, [idCheck.data, request.user.tenant_id])
      if (!sub.rows[0]) return reply.code(404).send({ error: 'Submissão pendente não encontrada.' })
      const s = sub.rows[0]
      const rows = await db.query(`WITH candidates AS (SELECT l.id,l.iniciado_em,l.encerrado_em,l.marca_id,m.nome AS marca_nome,c.nome AS cabine_nome,c.numero AS cabine_numero,COALESCE(l.ads_gmv,l.manual_gmv,l.fat_gerado,0)::numeric AS gmv,l.origem_dados
        FROM lives l
        LEFT JOIN marcas m ON m.id=l.marca_id AND m.tenant_id=l.tenant_id
        LEFT JOIN cabines c ON c.id=l.cabine_id AND c.tenant_id=l.tenant_id
        WHERE l.tenant_id=$1::uuid AND l.status='encerrada' AND l.marca_id=$2::uuid
          AND l.uniao_destino_id IS NULL AND l.uniao_desfeita_em IS NULL
          AND (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date=(($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date)
          AND (l.apresentador_id=(SELECT user_id FROM apresentadoras WHERE id=$4::uuid AND tenant_id=$1::uuid)
            OR EXISTS (SELECT 1 FROM live_apresentadores la WHERE la.live_id=l.id AND la.tenant_id=l.tenant_id AND la.apresentador_id=(SELECT user_id FROM apresentadoras WHERE id=$4::uuid AND tenant_id=$1::uuid))
            OR EXISTS (SELECT 1 FROM live_apresentadoras_v2 lav WHERE lav.live_id=l.id AND lav.tenant_id=l.tenant_id AND lav.apresentadora_id=$4::uuid))
          AND NOT EXISTS (SELECT 1 FROM apresentadora_live_submissoes linked WHERE linked.tenant_id=l.tenant_id AND linked.live_oficial_id=l.id AND linked.apresentadora_id=$4::uuid)
        ) SELECT page.*,totals.total_count FROM (SELECT COUNT(*) AS total_count FROM candidates) totals
        LEFT JOIN LATERAL (SELECT * FROM candidates ORDER BY ABS(EXTRACT(EPOCH FROM (iniciado_em-$3::timestamptz))),id LIMIT 25 OFFSET $5) page ON TRUE`, [request.user.tenant_id, s.marca_id, s.iniciado_em, s.apresentadora_id, page * 25])
      return { items: rows.rows.filter(row => row.id).map(({ total_count, ...row }) => ({ ...row, gmv: Number(row.gmv ?? 0) })), total: Number(rows.rows[0]?.total_count ?? 0), page, limit: 25 }
    })
  })

  app.post('/v1/lives/submissoes-apresentadoras/:id/devolver', { preHandler: reviewAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); const parsed = devolucaoSchema.safeParse(request.body); if (!idCheck.success || !parsed.success) return reply.code(400).send({ error: !idCheck.success ? 'id inválido' : parsed.error.issues[0].message })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      return inSubmissionTransaction(db, async () => { const row = await db.query(`UPDATE apresentadora_live_submissoes SET status='devolvida',motivo_devolucao=$4,revisado_por=$3::uuid,revisado_em=NOW(),atualizado_em=NOW(),versao=versao+1,arquivamento_status=CASE WHEN $5::boolean THEN 'solicitado' ELSE NULL END,motivo_contestacao=NULL WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='pendente' AND ($6::int IS NULL OR versao=$6) RETURNING id,status,motivo_devolucao,versao,arquivamento_status`, [idCheck.data, request.user.tenant_id, request.user.sub, parsed.data.motivo, parsed.data.arquivar ?? false, parsed.data.versao_esperada ?? null])
      if (!row.rows[0]) return reply.code(409).send({ error: 'Submissão não encontrada ou já revisada.' }); await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: row.rows[0].id, version: row.rows[0].versao, action: 'devolvida', actorId: request.user.sub, motivo: parsed.data.motivo }); return row.rows[0]
      })
    })
  })

  app.post('/v1/lives/submissoes-apresentadoras/aprovar-dia', { preHandler: reviewAccess }, async (request, reply) => {
    const parsed = batchApproveDaySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    if (!saoPauloDayBounds(parsed.data.data)) return reply.code(400).send({ error: 'data inválida.' })
    const tenantId = request.user.tenant_id
    const revisorId = request.user.sub
    const rows = await withPortalPresenterDb(app, tenantId, async (db) => db.query(
      `SELECT id, status, arquivamento_status, marca_id, iniciado_em, encerrado_em,
              gmv_declarado, pedidos_declarados, live_impressions_declaradas, manual_views_declaradas
         FROM apresentadora_live_submissoes
        WHERE tenant_id=$1::uuid
          AND (iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date=$2::date
        ORDER BY criado_em ASC`,
      [tenantId, parsed.data.data],
    ))
    const approved = []
    const skipped = []
    const failed = []
    for (const row of rows.rows) {
      if (row.status !== 'pendente') {
        skipped.push({ id: row.id, reason: 'Envio não está pendente.' })
        continue
      }
      if (row.arquivamento_status) {
        skipped.push({ id: row.id, reason: 'Aguardando resposta de arquivamento.' })
        continue
      }
      const rawOficial = oficialPayloadFromSubmission(row)
      const normalized = normalizeOfficialMetrics(rawOficial)
      if (!normalized.data) {
        skipped.push({ id: row.id, reason: normalized.error })
        continue
      }
      if (!normalized.data.marca_id || normalized.data.gmv_oficial == null || normalized.data.pedidos_oficiais == null || !submissionTimesAreApprovable(normalized.data)) {
        skipped.push({ id: row.id, reason: 'Dados incompletos ou horário inválido para aprovação automática.' })
        continue
      }
      try {
        const result = await withPortalPresenterDb(app, tenantId, async (db) => aprovarSubmissaoComOficial(db, {
          tenantId,
          revisorId,
          submissionId: row.id,
          parsed: normalized.data,
          recordHistory,
        }))
        approved.push({ id: result.id, live_oficial_id: result.live_oficial_id })
      } catch (error) {
        failed.push({ id: row.id, error: error.message ?? 'Erro ao aprovar envio.' })
      }
    }
    return { data: parsed.data.data, approved, skipped, failed }
  })

  app.post('/v1/lives/submissoes-apresentadoras/:id/aprovar', { preHandler: reviewAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); const parsed = reviewSchema.safeParse(request.body); if (!idCheck.success || !parsed.success) return reply.code(400).send({ error: !idCheck.success ? 'id inválido' : parsed.error.issues[0].message })
    const normalized = normalizeOfficialMetrics(parsed.data); if (!normalized.data) return reply.code(400).send({ error: normalized.error, field_errors: { [normalized.field]: normalized.error } })
    parsed.data = normalized.data
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      try {
        return await aprovarSubmissaoComOficial(db, {
          tenantId: request.user.tenant_id,
          revisorId: request.user.sub,
          submissionId: idCheck.data,
          parsed: parsed.data,
          recordHistory,
        })
      } catch (error) {
        if (error.statusCode) return reply.code(error.statusCode).send({ error: error.message })
        throw error
      }
    })
  })

}
