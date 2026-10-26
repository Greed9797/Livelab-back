import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { READ_TRAINING } from '../config/role_groups.js'
import { invalidateNamespace, withCache } from '../lib/dashboard-cache.js'
import { mergeWatchedIntervals, videoSource, watchedPercent } from '../services/training-progress.js'
import {
  assembleHome,
  assembleTrail,
  audienceForRole,
  hydrateLesson,
  nextLessonInTrail,
  normalizeTitle,
  resumePath,
} from '../services/training.js'

const uuid = z.string().uuid()
const STARTER_SLUG = 'primeira-live-que-converte'
const CATALOG_TTL_MS = Number(process.env.TRAINING_CATALOG_TTL_MS ?? 60_000)
const adminOnly = ['franqueador_master']
const reportRoles = ['franqueador_master', 'franqueado', 'gerente']

function slugifyTitle(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 180) || randomUUID()
}

function bustCatalog() { invalidateNamespace('training:catalog') }

async function withCatalogTransaction(app, run) {
  const client = await app.db.pool.connect()
  await client.query('BEGIN')
  try { const result = await run(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

function validIntervals(intervals, duration) {
  return Array.isArray(intervals) && intervals.length <= 5000 && intervals.every((range) => (
    Array.isArray(range) && range.length === 2 && range.every(Number.isFinite)
      && range[0] >= 0 && range[1] > range[0] && range[1] <= duration
  ))
}

async function playableVideo(app, request, lesson) {
  if (lesson.source_kind === 'direct_video') {
    return videoSource(lesson.video_provider, lesson.video_url ?? lesson.video_id, lesson.video_library_id)
  }
  if (lesson.source_kind === 'network_article' && lesson.source_slug) {
    const { rows } = await app.db.query("SELECT video_provider,video_url,url FROM manuais WHERE slug=$1 AND status='published'", [lesson.source_slug])
    const source = rows[0]
    if (!source || !['youtube','panda'].includes(source.video_provider)) return null
    return videoSource(source.video_provider, source.video_url ?? source.url)
  }
  if (lesson.source_kind === 'unit_material' && (lesson.source_slug || lesson.source_title)) {
    const { rows } = await app.withTenant(request.user.tenant_id, (db) => db.query("SELECT video_provider,video_id,external_url FROM knowledge_materials WHERE tenant_id=$1 AND status='published' AND (slug=$2 OR title=$3) ORDER BY CASE WHEN slug=$2 THEN 0 ELSE 1 END LIMIT 1", [request.user.tenant_id, lesson.source_slug ?? null, lesson.source_title ?? null]))
    const source = rows[0]
    if (!source || !['youtube','panda'].includes(source.video_provider)) return null
    return videoSource(source.video_provider, source.video_provider === 'youtube'
      ? (source.video_id ?? source.external_url)
      : (source.external_url ?? source.video_id))
  }
  return null
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function asList(value) {
  return Array.isArray(value) ? value : []
}

function sourceKeys(lessons) {
  return {
    slugs: [...new Set(lessons.map((lesson) => lesson.source_slug).filter(Boolean))],
    titles: [...new Set(lessons.map((lesson) => lesson.source_title).filter(Boolean))],
  }
}

function buildSources(networkRows = [], unitRows = []) {
  const network = new Map()
  for (const row of networkRows) if (row.slug) network.set(row.slug, row)
  const unit = new Map()
  const unitBySlug = new Map()
  const unitByTitle = new Map()
  for (const row of unitRows) {
    const title = row.title ?? row.titulo
    if (title) {
      unit.set(normalizeTitle(title), row)
      unitByTitle.set(normalizeTitle(title), row)
    }
    if (row.slug) {
      unit.set(row.slug, row)
      unitBySlug.set(row.slug, row)
    }
  }
  return { network, unit, unitBySlug, unitByTitle }
}

async function loadCatalog(app) {
  const { value } = await withCache({
    namespace: 'training:catalog',
    key: 'global',
    ttlMs: CATALOG_TTL_MS,
    computeFn: async () => {
      const result = await app.db.query(`
        SELECT
          (SELECT COALESCE(json_agg(t ORDER BY t.sort_order, t.title), '[]'::json)
             FROM training_trails t WHERE t.is_active = true) AS trails,
          (SELECT COALESCE(json_agg(m ORDER BY m.sort_order, m.title), '[]'::json)
             FROM training_modules m) AS modules,
          (SELECT COALESCE(json_agg(l ORDER BY l.sort_order, l.title), '[]'::json)
             FROM training_lessons l) AS lessons,
          (SELECT COALESCE(json_agg(u ORDER BY u.published_at DESC), '[]'::json)
             FROM training_updates u WHERE u.is_active = true) AS updates
      `)
      const row = result.rows[0] ?? {}
      return {
        trails: asList(row.trails),
        modules: asList(row.modules),
        lessons: asList(row.lessons),
        updates: asList(row.updates),
      }
    },
  })
  return {
    trails: [...value.trails],
    modules: [...value.modules],
    lessons: [...value.lessons],
    updates: [...value.updates],
  }
}

async function loadNetworkSources(app, slugs, { includeDerived = false } = {}) {
  const sourceSql = `
    SELECT id, slug, titulo, excerpt, cover_image_url, estimated_read_minutes, difficulty,
           objectives, prerequisites, audience_roles, topics, platforms, destaque,
           published_at, atualizado_em AS updated_at,
           content_markdown, video_provider, video_url, url
      FROM manuais
     WHERE status = 'published' AND slug = ANY($1::text[])`
  const derivedSql = `
    SELECT id, slug, titulo, excerpt, published_at, atualizado_em AS updated_at,
           audience_roles, topics, destaque
      FROM manuais
     WHERE status = 'published'
     ORDER BY COALESCE(atualizado_em, published_at) DESC NULLS LAST
     LIMIT 6`
  const [sources, derived] = await Promise.all([
    slugs.length ? app.db.query(sourceSql, [slugs]) : Promise.resolve({ rows: [] }),
    includeDerived ? app.db.query(derivedSql) : Promise.resolve({ rows: [] }),
  ])
  return {
    networkRows: sources.rows,
    derivedNetwork: derived.rows.map((row) => ({ ...row, origin_kind: 'network_article' })),
  }
}

async function loadTenantBundle(app, request, {
  slugs = [],
  titles = [],
  includeDerived = false,
  startLessonId = null,
} = {}) {
  const { tenant_id, sub } = request.user
  return app.withTenant(tenant_id, async (db) => {
    if (startLessonId) {
      await db.query(
        `INSERT INTO training_lesson_progress (tenant_id, user_id, lesson_id, started_at, last_opened_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (tenant_id, user_id, lesson_id) DO UPDATE
           SET last_opened_at = NOW()`,
        [tenant_id, sub, startLessonId],
      )
    }
    const result = await db.query(
      `SELECT
         (SELECT COALESCE(json_agg(json_build_object(
            'lesson_id', p.lesson_id,
            'started_at', p.started_at,
            'last_opened_at', p.last_opened_at,
            'completed_at', p.completed_at
          )), '[]'::json)
            FROM training_lesson_progress p JOIN training_lessons pl ON pl.id=p.lesson_id
           WHERE p.tenant_id = $1 AND p.user_id = $2 AND pl.video_version=1) AS progress,
         (SELECT COALESCE(json_agg(json_build_object(
            'lesson_id', p.lesson_id, 'started_at', p.started_at, 'last_opened_at', p.last_opened_at,
            'completed_at', p.completed_at, 'watched_percent', p.watched_percent,
            'last_position_seconds', p.last_position_seconds, 'duration_seconds', p.duration_seconds,
            'position_revision', p.position_revision, 'video_version', p.video_version,
            'completion_source', p.completion_source
          )), '[]'::json)
            FROM training_video_progress p JOIN training_lessons vl ON vl.id = p.lesson_id
           WHERE p.tenant_id = $1 AND p.user_id = $2 AND p.video_version = vl.video_version) AS video_progress,
         (SELECT COALESCE(json_agg(b.lesson_id), '[]'::json)
            FROM training_bookmarks b
           WHERE b.tenant_id = $1 AND b.user_id = $2) AS bookmark_ids,
         (SELECT CASE
            WHEN cardinality($3::text[]) = 0 AND cardinality($4::text[]) = 0 THEN '[]'::json
            ELSE COALESCE(json_agg(m), '[]'::json)
          END
            FROM (
              SELECT id, slug, title, title AS titulo, excerpt, cover_image_url, duration_minutes, difficulty,
                     objectives, prerequisites, audience_roles, topics, platforms, featured, published_at, updated_at,
                     content_markdown, video_provider, video_id, external_url
                FROM knowledge_materials
               WHERE tenant_id = $1 AND status = 'published'
                 AND (title = ANY($4::text[]) OR slug = ANY($3::text[]))
            ) m) AS unit_materials,
         (SELECT COALESCE(json_agg(u), '[]'::json)
            FROM (
              SELECT id, slug, title, title AS titulo, excerpt, published_at, updated_at, audience_roles, topics, featured
                FROM knowledge_materials
               WHERE $5::boolean AND tenant_id = $1 AND status = 'published'
               ORDER BY updated_at DESC, id
               LIMIT 6
            ) u) AS derived_unit`,
      [tenant_id, sub, slugs, titles, includeDerived],
    )
    const row = result.rows[0] ?? {}
    const videoProgress = asList(row.video_progress)
    const byLesson = new Map(asList(row.progress).map((item) => [item.lesson_id, {
      ...item, watched_percent: null, last_position_seconds: 0, duration_seconds: null,
      position_revision: 0, video_version: 1, completion_source: item.completed_at ? 'legacy' : null,
    }]))
    for (const raw of videoProgress) {
      const item = { ...raw, watched_percent: raw.watched_percent == null ? null : Number(raw.watched_percent) }
      const legacy = byLesson.get(item.lesson_id)
      byLesson.set(item.lesson_id, legacy?.completed_at && item.video_version === 1
        ? { ...legacy, ...item, started_at: legacy.started_at, completed_at: legacy.completed_at, watched_percent: null, completion_source: 'legacy' }
        : item)
    }
    return {
      progressRows: [...byLesson.values()],
      bookmarkIds: asList(row.bookmark_ids),
      unitRows: asList(row.unit_materials),
      derivedUpdates: asList(row.derived_unit).map((item) => ({ ...item, origin_kind: 'unit_material' })),
    }
  })
}

async function loadHomeContext(app, request, lessons) {
  const { slugs, titles } = sourceKeys(lessons)
  const [network, tenant] = await Promise.all([
    loadNetworkSources(app, slugs, { includeDerived: true }),
    loadTenantBundle(app, request, { slugs, titles, includeDerived: true }),
  ])
  return {
    progressRows: tenant.progressRows,
    bookmarkIds: tenant.bookmarkIds,
    sources: buildSources(network.networkRows, tenant.unitRows),
    derivedUpdates: [...network.derivedNetwork, ...tenant.derivedUpdates],
  }
}

async function loadTrailContext(app, request, lessons, { startLessonId = null } = {}) {
  const { slugs, titles } = sourceKeys(lessons)
  const [network, tenant] = await Promise.all([
    loadNetworkSources(app, slugs),
    loadTenantBundle(app, request, { slugs, titles, startLessonId }),
  ])
  return {
    progressRows: tenant.progressRows,
    bookmarkIds: tenant.bookmarkIds,
    sources: buildSources(network.networkRows, tenant.unitRows),
  }
}

function findLesson(lessons, key) {
  return lessons.find((lesson) => lesson.id === key)
}

function assembleTrailPayload({ trail, catalog, progressRows, bookmarkIds, sources }) {
  return assembleTrail({
    trail,
    modules: catalog.modules,
    lessons: catalog.lessons,
    progressByLesson: new Map(progressRows.map((row) => [row.lesson_id, row])),
    bookmarks: new Set(bookmarkIds),
    sources,
  })
}

export async function trainingRoutes(app) {
  const readers = [app.authenticate, app.requirePapel(READ_TRAINING)]

  app.get('/v1/training/admin/trails', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async () => {
    const catalog = await loadCatalog(app)
    return { items: catalog.trails.map((trail) => ({
      id: trail.id, slug: trail.slug, title: trail.title,
      cover_image_url: trail.cover_image_url ?? null, sort_order: trail.sort_order,
      lessons: catalog.lessons.filter((lesson) => catalog.modules.some((module) => (
        module.id === lesson.module_id && module.trail_id === trail.id
      ))).sort((a, b) => a.global_position - b.global_position).map((lesson) => ({
        id: lesson.id, title: lesson.title, cover_image_url: lesson.cover_image_url ?? null,
        video_provider: lesson.video_provider, video_id: lesson.video_id,
        video_library_id: lesson.video_library_id, video_url: lesson.video_url,
        sort_order: lesson.global_position,
      })),
    })) }
  })

  app.post('/v1/training/admin/trails', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async (request, reply) => {
    const parsed = z.object({ title: z.string().trim().min(2).max(240), cover_image_url: z.string().url().startsWith('https://').optional().nullable(), sort_order: z.number().int().optional() }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { title, cover_image_url = null, sort_order = 0 } = parsed.data
    const id = randomUUID()
    const slug = `${slugifyTitle(title)}-${id.slice(0, 8)}`
    const moduleId = randomUUID()
    const client = await app.db.pool.connect()
    await client.query('BEGIN')
    try {
      const trail = await client.query(`INSERT INTO training_trails (id, slug, title, outcome, cover_image_url, sort_order) VALUES ($1,$2,$3,$3,$4,$5) RETURNING id,slug,title,cover_image_url,sort_order`, [id, slug, title, cover_image_url, sort_order])
      await client.query(`INSERT INTO training_modules (id,trail_id,title,sort_order) VALUES ($1,$2,'Aulas',1)`, [moduleId, id])
      await client.query('COMMIT')
      bustCatalog()
      return reply.code(201).send({ ...trail.rows[0], lessons: [] })
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  })

  app.patch('/v1/training/admin/trails/:id', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const parsed = z.object({ title: z.string().trim().min(2).max(240).optional(), cover_image_url: z.string().url().startsWith('https://').nullable().optional(), sort_order: z.number().int().optional() }).strict().safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const p = parsed.data
    const result = await app.db.query(`UPDATE training_trails SET title=COALESCE($2,title), cover_image_url=CASE WHEN $3::boolean THEN $4 ELSE cover_image_url END, sort_order=COALESCE($5,sort_order), updated_at=NOW() WHERE id=$1 RETURNING id,slug,title,cover_image_url,sort_order`, [request.params.id, p.title ?? null, Object.hasOwn(p, 'cover_image_url'), p.cover_image_url ?? null, p.sort_order ?? null])
    if (!result.rows.length) return reply.code(404).send({ error: 'Trilha não encontrada' })
    bustCatalog(); return result.rows[0]
  })

  app.delete('/v1/training/admin/trails/:id', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const result = await app.db.query('DELETE FROM training_trails WHERE id=$1 RETURNING id', [request.params.id])
    if (!result.rows.length) return reply.code(404).send({ error: 'Trilha não encontrada' })
    bustCatalog(); return reply.code(204).send()
  })

  app.post('/v1/training/admin/trails/reorder', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async (request, reply) => {
    const parsed = z.object({ ids: z.array(uuid).min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    if (new Set(parsed.data.ids).size !== parsed.data.ids.length) return reply.code(400).send({ error: 'IDs duplicados' })
    const changed = await withCatalogTransaction(app, async (db) => {
      const current = await db.query('SELECT id FROM training_trails WHERE is_active=true ORDER BY sort_order,title FOR UPDATE')
      if (current.rows.length !== parsed.data.ids.length || current.rows.some((row) => !parsed.data.ids.includes(row.id))) return false
      for (const [sort, id] of parsed.data.ids.entries()) await db.query('UPDATE training_trails SET sort_order=$2, updated_at=NOW() WHERE id=$1', [id, sort])
      return true
    })
    if (!changed) return reply.code(400).send({ error: 'A lista deve conter todas as trilhas ativas.' })
    bustCatalog(); return { ok: true }
  })

  app.post('/v1/training/admin/trails/:id/lessons', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const parsed = z.object({ title: z.string().trim().min(2).max(240), cover_image_url: z.string().url().startsWith('https://').optional().nullable(), video_provider: z.enum(['youtube','panda']), video_input: z.string().min(1).max(2048), video_library_id: z.string().min(1).max(128).nullable().optional(), sort_order: z.number().int().optional() }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const media = videoSource(parsed.data.video_provider, parsed.data.video_input, parsed.data.video_library_id)
    if (!media) return reply.code(400).send({ error: 'Vídeo inválido para o provedor selecionado.' })
    const trail = await app.db.query(`SELECT t.id,m.id AS module_id,COALESCE((SELECT MAX(l.global_position)+1 FROM training_lessons l JOIN training_modules lm ON lm.id=l.module_id WHERE lm.trail_id=t.id),0) AS next_position,COALESCE((SELECT MAX(l.sort_order)+1 FROM training_lessons l WHERE l.module_id=m.id),0) AS next_module_order FROM training_trails t JOIN training_modules m ON m.trail_id=t.id WHERE t.id=$1 ORDER BY m.sort_order LIMIT 1`, [request.params.id])
    if (!trail.rows.length) return reply.code(404).send({ error: 'Trilha não encontrada' })
    const data = parsed.data
    const position = data.sort_order ?? Number(trail.rows[0].next_position)
    const result = await app.db.query(`INSERT INTO training_lessons (id,module_id,sort_order,global_position,title,format,source_kind,video_provider,video_id,video_library_id,video_url,cover_image_url) VALUES ($1,$2,$3,$4,$5,'video','direct_video',$6,$7,$8,$9,$10) RETURNING id,title,cover_image_url,video_provider,video_id,video_library_id,video_url,global_position`, [randomUUID(), trail.rows[0].module_id, trail.rows[0].next_module_order, position, data.title, data.video_provider, media.id, media.libraryId, media.url, data.cover_image_url ?? null])
    bustCatalog(); return reply.code(201).send(result.rows[0])
  })

  app.patch('/v1/training/admin/lessons/:id', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const parsed = z.object({ title: z.string().trim().min(2).max(240).optional(), cover_image_url: z.string().url().startsWith('https://').nullable().optional(), video_provider: z.enum(['youtube','panda']).optional(), video_input: z.string().min(1).max(2048).optional(), video_library_id: z.string().min(1).max(128).nullable().optional(), sort_order: z.number().int().optional(), trail_id: uuid.optional() }).strict().safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const old = await app.db.query('SELECT l.*,m.trail_id FROM training_lessons l JOIN training_modules m ON m.id=l.module_id WHERE l.id=$1', [request.params.id])
    if (!old.rows.length) return reply.code(404).send({ error: 'Aula não encontrada' })
    const p = parsed.data, current = old.rows[0]
    const provider = p.video_provider ?? current.video_provider
    const mediaWasEdited = Boolean(p.video_provider || p.video_input || p.video_library_id)
    const media = mediaWasEdited ? videoSource(provider, p.video_input ?? current.video_url, Object.hasOwn(p,'video_library_id') ? p.video_library_id : current.video_library_id) : null
    if (mediaWasEdited && !media) return reply.code(400).send({ error: 'Vídeo inválido para o provedor selecionado.' })
    const mediaChanged = Boolean(media && (media.provider !== current.video_provider || media.id !== current.video_id || media.libraryId !== current.video_library_id))
    let targetModule = current.module_id
    let targetPosition = p.sort_order ?? current.global_position
    let moduleOrder = current.sort_order
    const moving = Boolean(p.trail_id && p.trail_id !== current.trail_id)
    if (moving) {
      const target = await app.db.query(`SELECT m.id AS module_id,COALESCE((SELECT MAX(l.sort_order)+1 FROM training_lessons l WHERE l.module_id=m.id),0) AS next_order,COALESCE((SELECT MAX(l.global_position)+1 FROM training_lessons l JOIN training_modules lm ON lm.id=l.module_id WHERE lm.trail_id=m.trail_id),0) AS next_position FROM training_modules m WHERE m.trail_id=$1 ORDER BY m.sort_order LIMIT 1`, [p.trail_id])
      if (!target.rows.length) return reply.code(404).send({ error: 'Trilha não encontrada' })
      targetModule = target.rows[0].module_id
      targetPosition = Number(target.rows[0].next_position)
      moduleOrder = Number(target.rows[0].next_order)
    }
    const result = await app.db.query(`UPDATE training_lessons SET module_id=$12,source_kind=CASE WHEN $14::boolean THEN 'direct_video' ELSE source_kind END,format=CASE WHEN $14::boolean THEN 'video' ELSE format END,title=COALESCE($2,title), cover_image_url=CASE WHEN $3::boolean THEN $4 ELSE cover_image_url END, global_position=$5, sort_order=$13, video_provider=COALESCE($6,video_provider), video_id=COALESCE($7,video_id), video_library_id=CASE WHEN $8::boolean THEN $9 ELSE video_library_id END, video_url=COALESCE($10,video_url), video_version=video_version+$11 WHERE id=$1 RETURNING id,title,cover_image_url,video_provider,video_id,video_library_id,video_url,global_position,video_version`, [request.params.id,p.title ?? null,Object.hasOwn(p,'cover_image_url'),p.cover_image_url ?? null,targetPosition,media?.provider ?? null,media?.id ?? null,Object.hasOwn(p,'video_library_id') || mediaChanged,media?.libraryId ?? null,media?.url ?? null,mediaChanged ? 1 : 0,targetModule,moduleOrder,Boolean(media)])
    bustCatalog(); return result.rows[0]
  })

  app.delete('/v1/training/admin/lessons/:id', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const result = await app.db.query('DELETE FROM training_lessons WHERE id=$1 RETURNING id', [request.params.id])
    if (!result.rows.length) return reply.code(404).send({ error: 'Aula não encontrada' })
    bustCatalog(); return reply.code(204).send()
  })

  app.post('/v1/training/admin/trails/:id/lessons/reorder', { onRequest: [app.authenticate, app.requirePapel(adminOnly)] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const parsed = z.object({ ids: z.array(uuid).min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    if (new Set(parsed.data.ids).size !== parsed.data.ids.length) return reply.code(400).send({ error: 'IDs duplicados' })
    const changed = await withCatalogTransaction(app, async (db) => {
      const current = await db.query('SELECT l.id FROM training_lessons l JOIN training_modules m ON m.id=l.module_id WHERE m.trail_id=$1 ORDER BY l.global_position FOR UPDATE OF l', [request.params.id])
      if (current.rows.length !== parsed.data.ids.length || current.rows.some((row) => !parsed.data.ids.includes(row.id))) return false
      for (const [position, id] of parsed.data.ids.entries()) await db.query('UPDATE training_lessons SET global_position=$2 WHERE id=$1', [id, position])
      return true
    })
    if (!changed) return reply.code(400).send({ error: 'A lista deve conter todas as aulas desta trilha.' })
    bustCatalog(); return { ok: true }
  })

  app.get('/v1/training/reports', { onRequest: [app.authenticate, app.requirePapel(reportRoles)] }, async (request, reply) => {
    const schema = z.object({ user_id: uuid.optional(), trail_id: uuid.optional(), page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25) })
    const parsed = schema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { user_id, trail_id, page, page_size } = parsed.data
    return app.withTenant(request.user.tenant_id, async (db) => {
      const roles = READ_TRAINING
      const rows = await db.query(`SELECT u.id AS user_id,u.nome AS user_name,u.email AS user_email,t.id AS trail_id,t.title AS trail_title,l.id AS lesson_id,l.title AS lesson_title,COALESCE(vp.completed_at,CASE WHEN l.video_version=1 THEN lp.completed_at END) AS completed_at,CASE WHEN l.video_version=1 AND lp.completed_at IS NOT NULL THEN NULL ELSE vp.watched_percent::float8 END AS watched_percent,CASE WHEN l.video_version=1 AND lp.completed_at IS NOT NULL THEN 'legacy' WHEN vp.lesson_id IS NOT NULL THEN vp.completion_source WHEN l.video_version=1 AND lp.completed_at IS NOT NULL THEN 'legacy' ELSE NULL END AS completion_source,CASE WHEN COALESCE(vp.completed_at,CASE WHEN l.video_version=1 THEN lp.completed_at END) IS NOT NULL THEN 'completed' WHEN COALESCE(vp.started_at,CASE WHEN l.video_version=1 THEN lp.started_at END) IS NOT NULL THEN 'in_progress' ELSE 'not_started' END AS state FROM users u CROSS JOIN training_trails t JOIN training_modules m ON m.trail_id=t.id JOIN training_lessons l ON l.module_id=m.id LEFT JOIN training_lesson_progress lp ON lp.tenant_id=u.tenant_id AND lp.user_id=u.id AND lp.lesson_id=l.id LEFT JOIN training_video_progress vp ON vp.tenant_id=u.tenant_id AND vp.user_id=u.id AND vp.lesson_id=l.id AND vp.video_version=l.video_version WHERE u.tenant_id=$1 AND u.ativo=true AND u.papel=ANY($2::text[]) AND t.is_active=true AND ($3::uuid IS NULL OR u.id=$3) AND ($4::uuid IS NULL OR t.id=$4) ORDER BY u.nome,t.sort_order,l.global_position LIMIT $5 OFFSET $6`, [request.user.tenant_id, roles, user_id ?? null, trail_id ?? null, page_size + 1, (page - 1) * page_size])
      const more = rows.rows.length > page_size
      const users = await db.query('SELECT id,nome FROM users WHERE tenant_id=$1 AND ativo=true AND papel=ANY($2::text[]) ORDER BY nome', [request.user.tenant_id, roles])
      const trails = await db.query('SELECT id,title FROM training_trails WHERE is_active=true ORDER BY sort_order,title')
      return { items: rows.rows.slice(0,page_size), page, page_size, has_more: more, users: users.rows, trails: trails.rows }
    })
  })

  app.post('/v1/training/lessons/:id/progress', { onRequest: readers }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const schema = z.object({ video_version:z.number().int().positive(), duration_seconds:z.number().finite().min(1).max(86400), last_position_seconds:z.number().finite().min(0).max(86400), position_revision:z.number().int().min(0), intervals:z.array(z.array(z.number().finite()).length(2)).max(5000), playback_started:z.literal(true) }).strict()
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const data=parsed.data
    if (data.last_position_seconds > data.duration_seconds || !validIntervals(data.intervals,data.duration_seconds)) return reply.code(400).send({ error:'Intervalos ou posição fora da duração.' })
    const lessonResult = await app.db.query('SELECT id,source_kind,source_slug,source_title,format,video_provider,video_id,video_library_id,video_url,video_version FROM training_lessons WHERE id=$1', [request.params.id])
    const lesson = lessonResult.rows[0]
    if (!lesson) return reply.code(404).send({ error:'Aula não encontrada' })
    if (!(await playableVideo(app, request, lesson)) || lesson.video_version !== data.video_version) return reply.code(409).send({ error:'Versão de vídeo desatualizada.' })
    return app.withTenant(request.user.tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const { tenant_id, sub }=request.user
        const versionRow=await db.query('SELECT id,video_version FROM training_lessons WHERE id=$1 FOR SHARE',[lesson.id])
        if (!versionRow.rows[0] || versionRow.rows[0].video_version !== data.video_version) {
          await db.query('ROLLBACK'); return reply.code(409).send({error:'Versão de vídeo desatualizada.'})
        }
        await db.query(`INSERT INTO training_video_progress (tenant_id,user_id,lesson_id,video_version,started_at)
          VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (tenant_id,user_id,lesson_id,video_version) DO NOTHING`,
        [tenant_id,sub,lesson.id,data.video_version])
        const locked=await db.query('SELECT * FROM training_video_progress WHERE tenant_id=$1 AND user_id=$2 AND lesson_id=$3 AND video_version=$4 FOR UPDATE',[tenant_id,sub,lesson.id,data.video_version])
        const old=locked.rows[0]
        const duration=Number(old?.duration_seconds ?? data.duration_seconds)
        if (!validIntervals(data.intervals,duration) || data.last_position_seconds>duration) { await db.query('ROLLBACK'); return reply.code(400).send({error:'Intervalos ou posição fora da duração persistida.'}) }
        const intervals=mergeWatchedIntervals(old?.watched_intervals ?? [],data.intervals)
        const percent=watchedPercent(intervals,duration)
        const startedAt=old?.started_at ?? new Date()
        const positionMatches=(old?.position_revision ?? 0)===data.position_revision
        const lastPosition=positionMatches?data.last_position_seconds:(old?.last_position_seconds ?? 0)
        const nextRevision=positionMatches?data.position_revision+1:(old?.position_revision ?? 0)
        const completedAt=old?.completed_at ?? (percent>=90 ? new Date() : null)
        const saved=await db.query(`INSERT INTO training_video_progress (tenant_id,user_id,lesson_id,video_version,started_at,last_opened_at,completed_at,duration_seconds,last_position_seconds,position_revision,watched_intervals,watched_percent,completion_source) VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10::jsonb,$11,$12) ON CONFLICT (tenant_id,user_id,lesson_id,video_version) DO UPDATE SET last_opened_at=NOW(),completed_at=COALESCE(training_video_progress.completed_at,EXCLUDED.completed_at),duration_seconds=COALESCE(training_video_progress.duration_seconds,EXCLUDED.duration_seconds),last_position_seconds=CASE WHEN $13 THEN EXCLUDED.last_position_seconds ELSE training_video_progress.last_position_seconds END,position_revision=CASE WHEN $13 THEN EXCLUDED.position_revision ELSE training_video_progress.position_revision END,watched_intervals=EXCLUDED.watched_intervals,watched_percent=EXCLUDED.watched_percent,completion_source=COALESCE(training_video_progress.completion_source,EXCLUDED.completion_source) RETURNING lesson_id,started_at,last_opened_at,completed_at,watched_percent,last_position_seconds,duration_seconds,position_revision,video_version,completion_source`,[tenant_id,sub,lesson.id,data.video_version,startedAt,completedAt,duration,lastPosition,nextRevision,JSON.stringify(intervals),percent,completedAt?'watched':null,positionMatches])
        const legacy = data.video_version === 1
          ? (await db.query('SELECT started_at,completed_at FROM training_lesson_progress WHERE tenant_id=$1 AND user_id=$2 AND lesson_id=$3',[tenant_id,sub,lesson.id])).rows[0]
          : null
        await db.query('COMMIT')
        const result=saved.rows[0]
        const isLegacyCompleted = Boolean(legacy?.completed_at)
        return {
          ...result,
          started_at: isLegacyCompleted ? legacy.started_at : result.started_at,
          completed_at: isLegacyCompleted ? legacy.completed_at : result.completed_at,
          watched_percent: isLegacyCompleted || result.watched_percent == null ? null : Number(result.watched_percent),
          last_position_seconds: Number(result.last_position_seconds),
          duration_seconds: Number(result.duration_seconds),
          completion_source: isLegacyCompleted ? 'legacy' : result.completion_source,
          position_accepted: positionMatches,
          state: isLegacyCompleted || result.completed_at ? 'completed' : 'in_progress',
        }
      } catch(error) { await db.query('ROLLBACK').catch(()=>{}); throw error }
    })
  })

  app.get('/v1/training/home', { onRequest: readers }, async (request) => {
    const filters = {
      role: request.query?.role,
      level: request.query?.level,
      topic: request.query?.topic,
      platform: request.query?.platform,
      format: request.query?.format,
    }
    const catalog = await loadCatalog(app)
    const ctx = await loadHomeContext(app, request, catalog.lessons)
    return assembleHome({
      papel: request.user.papel,
      trails: catalog.trails,
      modules: catalog.modules,
      lessons: catalog.lessons,
      progressRows: ctx.progressRows,
      bookmarkIds: ctx.bookmarkIds,
      sources: ctx.sources,
      curatedUpdates: catalog.updates,
      derivedUpdates: ctx.derivedUpdates,
      filters,
    })
  })

  app.get('/v1/training/trails', { onRequest: readers }, async (request) => {
    const catalog = await loadCatalog(app)
    const ctx = await loadTrailContext(app, request, catalog.lessons)
    return {
      items: catalog.trails.map((trail) => assembleTrailPayload({
        trail,
        catalog,
        progressRows: ctx.progressRows,
        bookmarkIds: ctx.bookmarkIds,
        sources: ctx.sources,
      })),
    }
  })

  app.get('/v1/training/trails/:slug', { onRequest: readers }, async (request, reply) => {
    const catalog = await loadCatalog(app)
    const trail = catalog.trails.find((row) => row.slug === request.params.slug)
    if (!trail) return reply.code(404).send({ error: 'Trilha não encontrada' })
    const trailLessons = catalog.lessons.filter((lesson) => (
      catalog.modules.find((module) => module.id === lesson.module_id)?.trail_id === trail.id
    ))
    const ctx = await loadTrailContext(app, request, trailLessons)
    return assembleTrailPayload({
      trail,
      catalog,
      progressRows: ctx.progressRows,
      bookmarkIds: ctx.bookmarkIds,
      sources: ctx.sources,
    })
  })

  app.get('/v1/training/lessons/:id', { onRequest: readers }, async (request, reply) => {
    const catalog = await loadCatalog(app)
    const lesson = findLesson(catalog.lessons, request.params.id)
    if (!lesson) return reply.code(404).send({ error: 'Aula não encontrada' })
    const module = catalog.modules.find((row) => row.id === lesson.module_id)
    const trail = catalog.trails.find((row) => row.id === module?.trail_id)
    if (!module || !trail) return reply.code(404).send({ error: 'Aula não encontrada' })
    const trailLessons = catalog.lessons.filter((row) => (
      catalog.modules.find((item) => item.id === row.module_id)?.trail_id === trail.id
    ))
    const shouldStart = request.query?.start === 'true' && lesson.source_kind !== 'direct_video' && lesson.format !== 'video'
    const ctx = await loadTrailContext(app, request, trailLessons, { startLessonId: shouldStart ? lesson.id : null })
    const assembled = assembleTrailPayload({
      trail,
      catalog,
      progressRows: ctx.progressRows,
      bookmarkIds: ctx.bookmarkIds,
      sources: ctx.sources,
    })
    const card = assembled.modules.flatMap((row) => row.lessons).find((row) => row.id === lesson.id)
    const current = hydrateLesson(lesson, {
      sources: ctx.sources,
      progress: ctx.progressRows.find((row) => row.lesson_id === lesson.id),
      bookmarked: ctx.bookmarkIds.includes(lesson.id),
      includeContent: true,
    })
    return {
      ...card,
      ...current,
      next_lesson_id: card?.next_lesson_id ?? nextLessonInTrail(catalog.lessons, catalog.modules, lesson)?.id ?? null,
      trail: { id: trail.id, slug: trail.slug, title: trail.title },
      module: { id: module.id, title: module.title, sort_order: module.sort_order },
      resume_path: resumePath(trail.slug, lesson.id),
      outline: assembled.modules,
      ordered_lessons: assembled.ordered_lessons,
    }
  })

  app.post('/v1/training/lessons/:id/start', { onRequest: readers }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const exists = await app.db.query('SELECT id,source_kind,video_version,format FROM training_lessons WHERE id = $1', [request.params.id])
    if (!exists.rows.length) return reply.code(404).send({ error: 'Aula não encontrada' })
    const { tenant_id, sub } = request.user
    if (exists.rows[0].source_kind === 'direct_video' || exists.rows[0].format === 'video') {
      const result = await app.withTenant(tenant_id, (db) => db.query(
        `SELECT lesson_id,started_at,last_opened_at,completed_at,watched_percent,last_position_seconds,duration_seconds,position_revision,video_version,completion_source
           FROM training_video_progress WHERE tenant_id=$1 AND user_id=$2 AND lesson_id=$3 AND video_version=$4`,
        [tenant_id, sub, request.params.id, exists.rows[0].video_version],
      ))
      const progress = result.rows[0]
      return reply.code(200).send(progress ? {
        ...progress, watched_percent: progress.watched_percent == null ? null : Number(progress.watched_percent),
        last_position_seconds: Number(progress.last_position_seconds ?? 0), duration_seconds: progress.duration_seconds == null ? null : Number(progress.duration_seconds),
      } : { lesson_id: request.params.id, started_at: null, last_opened_at: null, completed_at: null, watched_percent: null, last_position_seconds: 0, duration_seconds: null, position_revision: 0, video_version: exists.rows[0].video_version, completion_source: null })
    }
    const result = await app.withTenant(tenant_id, (db) => db.query(
      `INSERT INTO training_lesson_progress (tenant_id, user_id, lesson_id, started_at, last_opened_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (tenant_id, user_id, lesson_id) DO UPDATE
         SET last_opened_at = NOW()
       RETURNING lesson_id, started_at, last_opened_at, completed_at`,
      [tenant_id, sub, request.params.id],
    ))
    return reply.code(200).send(result.rows[0])
  })

  app.post('/v1/training/lessons/:id/complete', { onRequest: readers }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const ordered = await app.db.query(
      `SELECT l.id, trail.slug, l.source_kind,l.source_slug,l.source_title,l.format,l.video_provider,l.video_id,l.video_library_id,l.video_url,l.video_version
         FROM training_lessons AS current_lesson
         JOIN training_modules AS current_module ON current_module.id = current_lesson.module_id
         JOIN training_trails AS trail ON trail.id = current_module.trail_id
         JOIN training_modules AS module ON module.trail_id = trail.id
         JOIN training_lessons AS l ON l.module_id = module.id
        WHERE current_lesson.id = $1
        ORDER BY l.global_position, module.sort_order, l.sort_order`,
      [request.params.id],
    )
    if (!ordered.rows.length) return reply.code(404).send({ error: 'Aula não encontrada' })
    const currentLesson = ordered.rows.find((row) => row.id === request.params.id)
    if (currentLesson.source_kind === 'direct_video' || await playableVideo(app, request, currentLesson)) return reply.code(409).send({ error: 'Vídeos são concluídos após assistir pelo menos 90%.' })
    const { tenant_id, sub } = request.user
    const result = await app.withTenant(tenant_id, (db) => db.query(
      `INSERT INTO training_lesson_progress (tenant_id, user_id, lesson_id, started_at, last_opened_at, completed_at)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW())
       ON CONFLICT (tenant_id, user_id, lesson_id) DO UPDATE
         SET completed_at = COALESCE(training_lesson_progress.completed_at, NOW()),
             last_opened_at = NOW()
       RETURNING lesson_id, started_at, last_opened_at, completed_at`,
      [tenant_id, sub, request.params.id],
    ))
    const index = ordered.rows.findIndex((row) => row.id === request.params.id)
    const next = ordered.rows[index + 1] ?? null
    return {
      ...result.rows[0],
      next_lesson_id: next?.id ?? null,
      resume_path: next ? resumePath(ordered.rows[0].slug, next.id) : null,
    }
  })

  app.get('/v1/training/progress', { onRequest: readers }, async (request) => {
    const { tenant_id, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const [legacy, measured] = await Promise.all([
        db.query('SELECT p.lesson_id,p.started_at,p.last_opened_at,p.completed_at FROM training_lesson_progress p JOIN training_lessons l ON l.id=p.lesson_id WHERE p.tenant_id=$1 AND p.user_id=$2 AND l.video_version=1', [tenant_id, sub]),
        db.query('SELECT p.lesson_id,p.started_at,p.last_opened_at,p.completed_at,p.watched_percent::float8 AS watched_percent,p.last_position_seconds,p.duration_seconds,p.position_revision,p.video_version,p.completion_source FROM training_video_progress p JOIN training_lessons l ON l.id=p.lesson_id WHERE p.tenant_id=$1 AND p.user_id=$2 AND p.video_version=l.video_version', [tenant_id, sub]),
      ])
      const progressByLesson = new Map(legacy.rows.map((item) => [item.lesson_id, { ...item, watched_percent:null,last_position_seconds:0,duration_seconds:null,position_revision:0,video_version:1,completion_source:item.completed_at?'legacy':null }]))
      for (const item of measured.rows) {
        const old=progressByLesson.get(item.lesson_id)
        progressByLesson.set(item.lesson_id, old?.completed_at && item.video_version===1
          ? { ...old,...item,started_at:old.started_at,completed_at:old.completed_at,watched_percent:null,completion_source:'legacy' }
          : item)
      }
      const progress = [...progressByLesson.values()].map((item) => ({
        ...item, watched_percent:item.watched_percent==null?null:Number(item.watched_percent),
        last_position_seconds:Number(item.last_position_seconds??0),duration_seconds:item.duration_seconds==null?null:Number(item.duration_seconds),
      }))
      const last = progress.sort((a, b) => new Date(b.last_opened_at) - new Date(a.last_opened_at))[0] ?? null
      if (!last) {
        return { audience: audienceForRole(request.user.papel), last_lesson: null, items: progress }
      }
      const lesson = await app.db.query(
        `SELECT l.id, l.title, trail.slug
           FROM training_lessons l
           JOIN training_modules module ON module.id = l.module_id
           JOIN training_trails trail ON trail.id = module.trail_id
          WHERE l.id = $1`,
        [last.lesson_id],
      )
      const row = lesson.rows[0]
      return {
        audience: audienceForRole(request.user.papel),
        last_lesson: row
          ? {
            id: row.id,
            title: row.title,
            state: last.completed_at ? 'completed' : 'in_progress',
            started_at: last.started_at,
            last_opened_at: last.last_opened_at,
            completed_at: last.completed_at,
            resume_path: resumePath(row.slug, row.id),
          }
          : null,
        items: progress,
      }
    })
  })

  app.get('/v1/training/bookmarks', { onRequest: readers }, async (request) => {
    const tenant = await loadTenantBundle(app, request)
    if (!tenant.bookmarkIds.length) return { items: [] }
    const catalog = await loadCatalog(app)
    const lessons = catalog.lessons.filter((lesson) => tenant.bookmarkIds.includes(lesson.id))
    const { slugs, titles } = sourceKeys(lessons)
    const [network, unit] = await Promise.all([
      loadNetworkSources(app, slugs),
      slugs.length || titles.length
        ? loadTenantBundle(app, request, { slugs, titles }).then((row) => row.unitRows)
        : Promise.resolve([]),
    ])
    const sources = buildSources(network.networkRows, unit)
    const progressByLesson = new Map(tenant.progressRows.map((row) => [row.lesson_id, row]))
    return {
      items: lessons.map((lesson) => hydrateLesson(lesson, {
        sources,
        progress: progressByLesson.get(lesson.id),
        bookmarked: true,
      })),
    }
  })

  app.post('/v1/training/bookmarks', { onRequest: readers }, async (request, reply) => {
    const parsed = z.object({ lesson_id: uuid }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const exists = await app.db.query('SELECT id FROM training_lessons WHERE id = $1', [parsed.data.lesson_id])
    if (!exists.rows.length) return reply.code(404).send({ error: 'Aula não encontrada' })
    const { tenant_id, sub } = request.user
    await app.withTenant(tenant_id, (db) => db.query(
      `INSERT INTO training_bookmarks (tenant_id, user_id, lesson_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id, lesson_id) DO NOTHING`,
      [tenant_id, sub, parsed.data.lesson_id],
    ))
    return reply.code(201).send({ lesson_id: parsed.data.lesson_id, bookmarked: true })
  })

  app.delete('/v1/training/bookmarks/:lessonId', { onRequest: readers }, async (request, reply) => {
    if (!isUuid(request.params.lessonId)) return reply.code(400).send({ error: 'lessonId inválido' })
    const { tenant_id, sub } = request.user
    await app.withTenant(tenant_id, (db) => db.query(
      'DELETE FROM training_bookmarks WHERE tenant_id = $1 AND user_id = $2 AND lesson_id = $3',
      [tenant_id, sub, request.params.lessonId],
    ))
    return reply.code(204).send()
  })

  app.get('/v1/training/starter', { onRequest: readers }, async (request, reply) => {
    const catalog = await loadCatalog(app)
    const trail = catalog.trails.find((row) => row.slug === STARTER_SLUG)
    if (!trail) return reply.code(404).send({ error: 'Trilha não encontrada' })
    const trailLessons = catalog.lessons.filter((lesson) => (
      catalog.modules.find((module) => module.id === lesson.module_id)?.trail_id === trail.id
    ))
    const ctx = await loadTrailContext(app, request, trailLessons)
    return assembleTrailPayload({
      trail,
      catalog,
      progressRows: ctx.progressRows,
      bookmarkIds: ctx.bookmarkIds,
      sources: ctx.sources,
    })
  })
}
