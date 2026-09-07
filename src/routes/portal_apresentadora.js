import { z } from 'zod'
import { getPerformanceRanking } from '../lib/performance-rollups.js'
import { monthRangeFromQuery } from '../lib/presenter-ranking.js'
import { presenterFixedSql } from '../config/presenter_defaults.js'
import { criarLiveOficialDaSubmissao } from '../services/portal-apresentadora-aprovacao.js'
import { getOwnPortalPerformance } from '../services/portal-apresentadora-performance.js'
import { withPortalPresenterDb } from '../services/portal-apresentadora-db.js'

const PORTAL_PAPEIS = ['apresentador', 'apresentadora']
const REVIEW_PAPEIS = ['franqueador_master', 'franqueado', 'gerente', 'operacional', 'produtor_live']
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const uuid = z.string().uuid()
const submissionSchema = z.object({
  marca_id: uuid.optional(),
  marca_descricao: z.string().trim().min(1).max(200).optional(),
  cabine_id: uuid.optional(),
  iniciado_em: z.string().datetime({ offset: true }),
  encerrado_em: z.string().datetime({ offset: true }),
  observacao: z.string().trim().max(2000).optional(),
  gmv_declarado: z.union([z.number().finite().min(0).max(9999999999999.99), z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)]).optional(),
  pedidos_declarados: z.union([z.number().int().min(0).max(2147483647), z.string().regex(/^\d+$/)]).refine((value) => Number(value) <= 2147483647, 'pedidos_declarados inválido').optional(),
  request_id: uuid.optional(),
}).strict()
const reviewSchema = z.object({
  live_id: uuid.optional(),
  marca_id: uuid.optional(), cabine_id: uuid.optional(),
  iniciado_em: z.string().datetime({ offset: true }).optional(),
  encerrado_em: z.string().datetime({ offset: true }).optional(),
  gmv_oficial: z.union([z.number().finite().min(0).max(9999999999999.99), z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)]).optional(),
  pedidos_oficiais: z.union([z.number().int().min(0).max(2147483647), z.string().regex(/^\d+$/)]).refine((value) => Number(value) <= 2147483647, 'pedidos_oficiais inválido').optional(),
}).strict()
const devolucaoSchema = z.object({ motivo: z.string().trim().min(1).max(1000) }).strict()

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
      'live_oficial_id',s.live_oficial_id,'motivo_devolucao',s.motivo_devolucao,
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

function requiresPast({ iniciado_em, encerrado_em }) {
  const start = new Date(iniciado_em)
  const end = new Date(encerrado_em)
  return Number.isFinite(start.valueOf()) && Number.isFinite(end.valueOf()) && end > start && end <= new Date() && (end - start) <= 24 * 60 * 60 * 1000
}

export async function portalApresentadoraRoutes(app) {
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
      const own = await getOwnPortalPerformance(db, { tenantId: request.user.tenant_id, apresentadoraId: profile.id, range })
      const ranking = await getPerformanceRanking(db, { tenantId: request.user.tenant_id, range, limit: 50, groupBy: 'apresentadora' })
      const safeRanking = ranking.map((row, index) => ({ posicao: index + 1, apresentadora_id: row.apresentadora_id, nome: row.nome, foto_url: row.foto_url, gmv_total: row.gmv_total, gmv_lives: row.gmv_lives, horas_live: row.horas_live, gmv_por_hora: row.gmv_por_hora, total_lives: row.total_lives, pedidos: row.pedidos, fixo: Number(row.fixo ?? 0), comissao_variavel: Number(row.comissao_variavel ?? 0), total_recebido: Number(row.total_recebido ?? 0) }))
      return { perfil: { id: profile.id, nome: profile.nome, foto_url: profile.foto_url ?? null }, desempenho: own.desempenho, remuneracao: { fixo: Number(profile.fixo ?? 0) }, ranking: safeRanking }
    })
  })

  app.get('/v1/portal/apresentadora/opcoes', { preHandler: ownAccess }, async (request, reply) => withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
    const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel)
    if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
    const [marcas, cabines] = await Promise.all([
      db.query(`SELECT m.id,m.nome FROM apresentadora_marcas am JOIN marcas m ON m.id=am.marca_id AND m.tenant_id=am.tenant_id WHERE am.tenant_id=$1::uuid AND am.apresentadora_id=$2::uuid AND am.ativo IS DISTINCT FROM FALSE AND m.status='ativa' ORDER BY m.nome`, [request.user.tenant_id, profile.id]),
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
        db.query(`SELECT s.id, s.status, s.marca_id, s.cabine_id, s.iniciado_em, s.encerrado_em, s.observacao, s.marca_descricao, s.gmv_declarado, s.pedidos_declarados, s.motivo_devolucao, s.versao, m.nome AS marca_nome, c.nome AS cabine_nome
          FROM apresentadora_live_submissoes s LEFT JOIN marcas m ON m.id=s.marca_id AND m.tenant_id=s.tenant_id LEFT JOIN cabines c ON c.id=s.cabine_id AND c.tenant_id=s.tenant_id
          WHERE s.tenant_id=$1::uuid AND s.apresentadora_id=$2::uuid AND s.iniciado_em >= ($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND s.iniciado_em < ($4::date::timestamp AT TIME ZONE 'America/Sao_Paulo') ORDER BY s.criado_em DESC`, [request.user.tenant_id, profile.id, range.start, range.end]),
      ])
      return { items: items.items, submissoes: pending.rows.map((row) => ({ ...row, gmv_declarado: row.gmv_declarado == null ? null : Number(row.gmv_declarado), pedidos_declarados: row.pedidos_declarados == null ? null : Number(row.pedidos_declarados) })) }
    })
  })

  app.post('/v1/portal/apresentadora/submissoes', { preHandler: ownAccess }, async (request, reply) => {
    const parsed = submissionSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    if (!requiresPast(parsed.data)) return reply.code(400).send({ error: 'Informe um intervalo já realizado e válido.' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel)
      if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      const d = parsed.data
      if (!d.marca_id && !d.marca_descricao) return reply.code(400).send({ error: 'Informe a marca ou descreva-a para conferência.' })
      if (d.marca_id) {
        const valid = await db.query(`SELECT 1 FROM apresentadora_marcas am JOIN marcas m ON m.id=am.marca_id AND m.tenant_id=am.tenant_id WHERE am.tenant_id=$1::uuid AND am.apresentadora_id=$2::uuid AND am.marca_id=$3::uuid AND am.ativo IS DISTINCT FROM FALSE AND m.status='ativa' LIMIT 1`, [request.user.tenant_id, profile.id, d.marca_id])
        if (!valid.rows[0]) return reply.code(404).send({ error: 'Marca não autorizada para esta apresentadora.' })
      }
      if (d.cabine_id) { const valid = await db.query(`SELECT 1 FROM cabines WHERE id=$1::uuid AND tenant_id=$2::uuid AND ativo IS DISTINCT FROM FALSE LIMIT 1`, [d.cabine_id, request.user.tenant_id]); if (!valid.rows[0]) return reply.code(404).send({ error: 'Cabine não encontrada.' }) }
      return inSubmissionTransaction(db, async () => {
      const created = await db.query(`INSERT INTO apresentadora_live_submissoes (tenant_id, apresentadora_id, marca_id, marca_descricao, cabine_id, iniciado_em, encerrado_em, observacao, gmv_declarado, pedidos_declarados, client_request_id)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::timestamptz,$7::timestamptz,$8,$9::numeric,$10::int,$11::uuid) ON CONFLICT (tenant_id,apresentadora_id,client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING RETURNING id,status,versao`, [request.user.tenant_id, profile.id, d.marca_id ?? null, d.marca_descricao ?? null, d.cabine_id ?? null, d.iniciado_em, d.encerrado_em, d.observacao ?? null, d.gmv_declarado ?? null, d.pedidos_declarados ?? null, d.request_id ?? null])
      if (!created.rows[0] && d.request_id) {
        const existing = await db.query(`SELECT id,status,versao,marca_id,marca_descricao,cabine_id,iniciado_em,encerrado_em,observacao,gmv_declarado,pedidos_declarados FROM apresentadora_live_submissoes WHERE tenant_id=$1::uuid AND apresentadora_id=$2::uuid AND client_request_id=$3::uuid`, [request.user.tenant_id, profile.id, d.request_id])
        const row = existing.rows[0]
        const same = row && row.marca_id === (d.marca_id ?? null) && row.marca_descricao === (d.marca_descricao ?? null) && row.cabine_id === (d.cabine_id ?? null) && new Date(row.iniciado_em).toISOString() === new Date(d.iniciado_em).toISOString() && new Date(row.encerrado_em).toISOString() === new Date(d.encerrado_em).toISOString() && row.observacao === (d.observacao ?? null) && Number(row.gmv_declarado ?? 0) === Number(d.gmv_declarado ?? 0) && Number(row.pedidos_declarados ?? 0) === Number(d.pedidos_declarados ?? 0)
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
    if (!requiresPast(parsed.data)) return reply.code(400).send({ error: 'Informe um intervalo já realizado e válido.' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel); if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      const d = parsed.data
      if (!d.marca_id && !d.marca_descricao) return reply.code(400).send({ error: 'Informe a marca ou descreva-a para conferência.' })
      if (d.marca_id) { const valid = await db.query(`SELECT 1 FROM apresentadora_marcas am JOIN marcas m ON m.id=am.marca_id AND m.tenant_id=am.tenant_id WHERE am.tenant_id=$1::uuid AND am.apresentadora_id=$2::uuid AND am.marca_id=$3::uuid AND am.ativo IS DISTINCT FROM FALSE AND m.status='ativa' LIMIT 1`, [request.user.tenant_id, profile.id, d.marca_id]); if (!valid.rows[0]) return reply.code(404).send({ error: 'Marca não autorizada para esta apresentadora.' }) }
      if (d.cabine_id) { const valid = await db.query(`SELECT 1 FROM cabines WHERE id=$1::uuid AND tenant_id=$2::uuid AND ativo IS DISTINCT FROM FALSE LIMIT 1`, [d.cabine_id, request.user.tenant_id]); if (!valid.rows[0]) return reply.code(404).send({ error: 'Cabine não encontrada.' }) }
      return inSubmissionTransaction(db, async () => { const updated = await db.query(`UPDATE apresentadora_live_submissoes SET marca_id=$4::uuid,marca_descricao=$5,cabine_id=$6::uuid,iniciado_em=$7::timestamptz,encerrado_em=$8::timestamptz,observacao=$9,gmv_declarado=$10::numeric,pedidos_declarados=$11::int,atualizado_em=NOW(),versao=versao+1 WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid AND status='devolvida' RETURNING id,status,versao`, [idCheck.data, request.user.tenant_id, profile.id, d.marca_id ?? null, d.marca_descricao ?? null, d.cabine_id ?? null, d.iniciado_em, d.encerrado_em, d.observacao ?? null, d.gmv_declarado ?? null, d.pedidos_declarados ?? null])
      if (!updated.rows[0]) return reply.code(404).send({ error: 'Submissão não encontrada ou não pode ser alterada.' }); await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: updated.rows[0].id, version: updated.rows[0].versao, action: 'editada', actorId: request.user.sub }); return updated.rows[0]
      })
    })
  })

  app.post('/v1/portal/apresentadora/submissoes/:id/reenviar', { preHandler: ownAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); if (!idCheck.success) return reply.code(400).send({ error: 'id inválido' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel); if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      return inSubmissionTransaction(db, async () => { const result = await db.query(`UPDATE apresentadora_live_submissoes SET status='pendente',motivo_devolucao=NULL,atualizado_em=NOW(),versao=versao+1 WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid AND status='devolvida' RETURNING id,status,versao`, [idCheck.data, request.user.tenant_id, profile.id])
      if (!result.rows[0]) return reply.code(404).send({ error: 'Submissão não encontrada ou não pode ser reenviada.' }); await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: result.rows[0].id, version: result.rows[0].versao, action: 'reenviada', actorId: request.user.sub }); return result.rows[0]
      })
    })
  })

  app.delete('/v1/portal/apresentadora/submissoes/:id', { preHandler: ownAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); if (!idCheck.success) return reply.code(400).send({ error: 'id inválido' })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const profile = await resolveOwnProfile(db, request.user.tenant_id, request.user.sub, request.user.papel); if (!profile) return reply.code(409).send({ error: 'Perfil de apresentadora não configurado.' })
      return inSubmissionTransaction(db, async () => {
        const row = await db.query(`UPDATE apresentadora_live_submissoes SET status='cancelada',atualizado_em=NOW(),versao=versao+1 WHERE id=$1::uuid AND tenant_id=$2::uuid AND apresentadora_id=$3::uuid AND status='devolvida' RETURNING id,status,versao`, [idCheck.data, request.user.tenant_id, profile.id])
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
      const rows = await db.query(`SELECT s.*,a.nome AS apresentadora_nome,m.nome AS marca_nome,c.nome AS cabine_nome FROM apresentadora_live_submissoes s JOIN apresentadoras a ON a.id=s.apresentadora_id AND a.tenant_id=s.tenant_id LEFT JOIN marcas m ON m.id=s.marca_id AND m.tenant_id=s.tenant_id LEFT JOIN cabines c ON c.id=s.cabine_id AND c.tenant_id=s.tenant_id WHERE s.tenant_id=$1::uuid AND ($2='all' OR s.status=$2) ORDER BY s.criado_em ASC`, [request.user.tenant_id, status])
      return { items: rows.rows.map((row) => ({ ...row, gmv_declarado: row.gmv_declarado == null ? null : Number(row.gmv_declarado) })) }
    })
  })

  app.post('/v1/lives/submissoes-apresentadoras/:id/devolver', { preHandler: reviewAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); const parsed = devolucaoSchema.safeParse(request.body); if (!idCheck.success || !parsed.success) return reply.code(400).send({ error: !idCheck.success ? 'id inválido' : parsed.error.issues[0].message })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      return inSubmissionTransaction(db, async () => { const row = await db.query(`UPDATE apresentadora_live_submissoes SET status='devolvida',motivo_devolucao=$4,revisado_por=$3::uuid,revisado_em=NOW(),atualizado_em=NOW() WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='pendente' RETURNING id,status,motivo_devolucao,versao`, [idCheck.data, request.user.tenant_id, request.user.sub, parsed.data.motivo])
      if (!row.rows[0]) return reply.code(409).send({ error: 'Submissão não encontrada ou já revisada.' }); await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: row.rows[0].id, version: row.rows[0].versao, action: 'devolvida', actorId: request.user.sub, motivo: parsed.data.motivo }); return row.rows[0]
      })
    })
  })

  app.post('/v1/lives/submissoes-apresentadoras/:id/aprovar', { preHandler: reviewAccess }, async (request, reply) => {
    const idCheck = uuid.safeParse(request.params?.id); const parsed = reviewSchema.safeParse(request.body); if (!idCheck.success || !parsed.success) return reply.code(400).send({ error: !idCheck.success ? 'id inválido' : parsed.error.issues[0].message })
    return withPortalPresenterDb(app, request.user.tenant_id, async (db) => {
      const sub = await db.query(`SELECT * FROM apresentadora_live_submissoes WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE`, [idCheck.data, request.user.tenant_id])
      if (!sub.rows[0]) return reply.code(409).send({ error: 'Submissão não encontrada ou já revisada.' })
      if (sub.rows[0].status === 'aprovada' && parsed.data.live_id === sub.rows[0].live_oficial_id) return { id: sub.rows[0].id, status: sub.rows[0].status, live_oficial_id: sub.rows[0].live_oficial_id, revisado_em: sub.rows[0].revisado_em }
      if (sub.rows[0].status !== 'pendente') return reply.code(409).send({ error: 'Submissão não encontrada ou já revisada.' })
      let liveId = parsed.data.live_id
      if (liveId) {
        const linked = await db.query(`SELECT id FROM apresentadora_live_submissoes WHERE tenant_id=$1::uuid AND apresentadora_id=$3::uuid AND live_oficial_id=$2::uuid FOR UPDATE`, [request.user.tenant_id, liveId, sub.rows[0].apresentadora_id])
        if (linked.rows[0]) return reply.code(409).send({ error: 'A live oficial já está vinculada a outra submissão.' })
        const allowed = await db.query(`SELECT 1 FROM lives l JOIN apresentadoras a ON a.id=$3::uuid AND a.tenant_id=l.tenant_id WHERE l.id=$1::uuid AND l.tenant_id=$2::uuid AND l.status='encerrada' AND (l.apresentador_id=a.user_id OR EXISTS (SELECT 1 FROM live_apresentadores la WHERE la.live_id=l.id AND la.tenant_id=l.tenant_id AND la.apresentador_id=a.user_id) OR EXISTS (SELECT 1 FROM live_apresentadoras_v2 lav WHERE lav.live_id=l.id AND lav.tenant_id=l.tenant_id AND lav.apresentadora_id=a.id)) FOR UPDATE OF l LIMIT 1`, [liveId, request.user.tenant_id, sub.rows[0].apresentadora_id])
        if (!allowed.rows[0]) return reply.code(422).send({ error: 'A live oficial não pertence à apresentadora ou não está encerrada.' })
      } else {
        if (!parsed.data.marca_id || !parsed.data.cabine_id || parsed.data.gmv_oficial == null || parsed.data.pedidos_oficiais == null || !requiresPast(parsed.data)) return reply.code(422).send({ error: 'Para criar a live oficial, informe marca, cabine, início, fim, GMV e pedidos conferidos pela gestão.' })
        liveId = await criarLiveOficialDaSubmissao(db, { tenantId: request.user.tenant_id, revisorId: request.user.sub, submissao: sub.rows[0], oficial: parsed.data })
      }
      const updated = await db.query(`UPDATE apresentadora_live_submissoes SET status='aprovada',live_oficial_id=$4::uuid,revisado_por=$3::uuid,revisado_em=NOW(),atualizado_em=NOW() WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='pendente' RETURNING id,status,live_oficial_id,revisado_em`, [idCheck.data, request.user.tenant_id, request.user.sub, liveId])
      if (!updated.rows[0]) throw Object.assign(new Error('Submissão já aprovada.'), { statusCode: 409 })
      await recordHistory(db, { tenantId: request.user.tenant_id, submissionId: updated.rows[0].id, version: sub.rows[0].versao, action: 'aprovada', actorId: request.user.sub })
      return updated.rows[0]
    })
  })

}
