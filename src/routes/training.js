import { z } from 'zod'
import { withCache } from '../lib/dashboard-cache.js'
import {
  TRAINING_READERS,
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
  for (const row of networkRows) network.set(row.slug, row)
  const unit = new Map()
  for (const row of unitRows) {
    unit.set(normalizeTitle(row.title), row)
    if (row.slug) unit.set(row.slug, row)
  }
  return { network, unit }
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
            FROM training_lesson_progress p
           WHERE p.tenant_id = $1 AND p.user_id = $2) AS progress,
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
    return {
      progressRows: asList(row.progress),
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
  const readers = [app.authenticate, app.requirePapel(TRAINING_READERS)]

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
    const shouldStart = request.query?.start !== 'false'
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
    }
  })

  app.post('/v1/training/lessons/:id/start', { onRequest: readers }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ error: 'id inválido' })
    const exists = await app.db.query('SELECT id FROM training_lessons WHERE id = $1', [request.params.id])
    if (!exists.rows.length) return reply.code(404).send({ error: 'Aula não encontrada' })
    const { tenant_id, sub } = request.user
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
      `SELECT l.id, trail.slug
         FROM training_lessons AS current_lesson
         JOIN training_modules AS current_module ON current_module.id = current_lesson.module_id
         JOIN training_trails AS trail ON trail.id = current_module.trail_id
         JOIN training_modules AS module ON module.trail_id = trail.id
         JOIN training_lessons AS l ON l.module_id = module.id
        WHERE current_lesson.id = $1
        ORDER BY module.sort_order, l.sort_order`,
      [request.params.id],
    )
    if (!ordered.rows.length) return reply.code(404).send({ error: 'Aula não encontrada' })
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
      const progress = await db.query(
        'SELECT lesson_id, started_at, last_opened_at, completed_at FROM training_lesson_progress WHERE tenant_id = $1 AND user_id = $2',
        [tenant_id, sub],
      )
      const last = [...progress.rows].sort((a, b) => new Date(b.last_opened_at) - new Date(a.last_opened_at))[0] ?? null
      if (!last) {
        return { audience: audienceForRole(request.user.papel), last_lesson: null, items: progress.rows }
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
        items: progress.rows,
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
