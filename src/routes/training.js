import { z } from 'zod'
import {
  TRAINING_READERS,
  assembleHome,
  assembleTrail,
  audienceForRole,
  hydrateLesson,
  normalizeTitle,
  resumePath,
} from '../services/training.js'

const uuid = z.string().uuid()
const STARTER_SLUG = 'primeira-live-que-converte'

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

async function loadCatalog(app) {
  const [trails, modules, lessons, updates] = await Promise.all([
    app.db.query('SELECT * FROM training_trails WHERE is_active = true ORDER BY sort_order, title'),
    app.db.query('SELECT * FROM training_modules ORDER BY sort_order, title'),
    app.db.query('SELECT * FROM training_lessons ORDER BY sort_order, title'),
    app.db.query('SELECT * FROM training_updates WHERE is_active = true ORDER BY published_at DESC'),
  ])
  return {
    trails: trails.rows,
    modules: modules.rows,
    lessons: lessons.rows,
    updates: updates.rows,
  }
}

async function loadLearnerState(app, request) {
  const { tenant_id, sub } = request.user
  return app.withTenant(tenant_id, async (db) => {
    const [progress, bookmarks] = await Promise.all([
      db.query(
        'SELECT lesson_id, started_at, last_opened_at, completed_at FROM training_lesson_progress WHERE tenant_id = $1 AND user_id = $2',
        [tenant_id, sub],
      ),
      db.query(
        'SELECT lesson_id FROM training_bookmarks WHERE tenant_id = $1 AND user_id = $2',
        [tenant_id, sub],
      ),
    ])
    return { progressRows: progress.rows, bookmarkIds: bookmarks.rows.map((row) => row.lesson_id) }
  })
}

async function loadSources(app, request, lessons) {
  const slugs = [...new Set(lessons.map((lesson) => lesson.source_slug).filter(Boolean))]
  const titles = [...new Set(lessons.map((lesson) => lesson.source_title).filter(Boolean))]
  const network = new Map()
  if (slugs.length) {
    const result = await app.db.query(
      `SELECT id, slug, titulo, excerpt, cover_image_url, estimated_read_minutes, difficulty,
              objectives, prerequisites, audience_roles, topics, platforms, destaque, published_at, atualizado_em AS updated_at
         FROM manuais
        WHERE status = 'published' AND slug = ANY($1::text[])`,
      [slugs],
    )
    for (const row of result.rows) network.set(row.slug, row)
  }
  const unit = new Map()
  if (titles.length || slugs.length) {
    const result = await app.withTenant(request.user.tenant_id, (db) => db.query(
      `SELECT id, slug, title, title AS titulo, excerpt, cover_image_url, duration_minutes, difficulty,
              objectives, prerequisites, audience_roles, topics, platforms, featured, published_at, updated_at
         FROM knowledge_materials
        WHERE tenant_id = $1 AND status = 'published'
          AND (
            title = ANY($2::text[])
            OR slug = ANY($3::text[])
          )`,
      [request.user.tenant_id, titles, slugs],
    ))
    for (const row of result.rows) {
      unit.set(normalizeTitle(row.title), row)
      unit.set(row.slug, row)
    }
  }
  return { network, unit }
}

async function loadDerivedUpdates(app, request) {
  const network = await app.db.query(
    `SELECT id, slug, titulo, excerpt, published_at, atualizado_em AS updated_at, audience_roles, topics, destaque
       FROM manuais
      WHERE status = 'published'
      ORDER BY COALESCE(atualizado_em, published_at) DESC NULLS LAST
      LIMIT 6`,
  )
  const unit = await app.withTenant(request.user.tenant_id, (db) => db.query(
    `SELECT id, slug, title, title AS titulo, excerpt, published_at, updated_at, audience_roles, topics, featured
       FROM knowledge_materials
      WHERE tenant_id = $1 AND status = 'published'
      ORDER BY updated_at DESC, id
      LIMIT 6`,
    [request.user.tenant_id],
  ))
  return [
    ...network.rows.map((row) => ({ ...row, origin_kind: 'network_article' })),
    ...unit.rows.map((row) => ({ ...row, origin_kind: 'unit_material' })),
  ]
}

function findLesson(lessons, key) {
  return isUuid(key)
    ? lessons.find((lesson) => lesson.id === key)
    : lessons.find((lesson) => lesson.id === key)
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
    const [state, sources, derivedUpdates] = await Promise.all([
      loadLearnerState(app, request),
      loadSources(app, request, catalog.lessons),
      loadDerivedUpdates(app, request),
    ])
    return assembleHome({
      papel: request.user.papel,
      trails: catalog.trails,
      modules: catalog.modules,
      lessons: catalog.lessons,
      progressRows: state.progressRows,
      bookmarkIds: state.bookmarkIds,
      sources,
      curatedUpdates: catalog.updates,
      derivedUpdates,
      filters,
    })
  })

  app.get('/v1/training/trails', { onRequest: readers }, async (request) => {
    const catalog = await loadCatalog(app)
    const [state, sources] = await Promise.all([
      loadLearnerState(app, request),
      loadSources(app, request, catalog.lessons),
    ])
    const progressByLesson = new Map(state.progressRows.map((row) => [row.lesson_id, row]))
    return {
      items: catalog.trails.map((trail) => assembleTrail({
        trail,
        modules: catalog.modules,
        lessons: catalog.lessons,
        progressByLesson,
        bookmarks: new Set(state.bookmarkIds),
        sources,
      })),
    }
  })

  app.get('/v1/training/trails/:slug', { onRequest: readers }, async (request, reply) => {
    const catalog = await loadCatalog(app)
    const trail = catalog.trails.find((row) => row.slug === request.params.slug)
    if (!trail) return reply.code(404).send({ error: 'Trilha não encontrada' })
    const [state, sources] = await Promise.all([
      loadLearnerState(app, request),
      loadSources(app, request, catalog.lessons),
    ])
    return assembleTrail({
      trail,
      modules: catalog.modules,
      lessons: catalog.lessons,
      progressByLesson: new Map(state.progressRows.map((row) => [row.lesson_id, row])),
      bookmarks: new Set(state.bookmarkIds),
      sources,
    })
  })

  app.get('/v1/training/lessons/:id', { onRequest: readers }, async (request, reply) => {
    const catalog = await loadCatalog(app)
    const lesson = findLesson(catalog.lessons, request.params.id)
    if (!lesson) return reply.code(404).send({ error: 'Aula não encontrada' })
    const module = catalog.modules.find((row) => row.id === lesson.module_id)
    const trail = catalog.trails.find((row) => row.id === module?.trail_id)
    if (!module || !trail) return reply.code(404).send({ error: 'Aula não encontrada' })
    const shouldStart = request.query?.start !== 'false'
    const { tenant_id, sub } = request.user
    if (shouldStart) {
      await app.withTenant(tenant_id, (db) => db.query(
        `INSERT INTO training_lesson_progress (tenant_id, user_id, lesson_id, started_at, last_opened_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (tenant_id, user_id, lesson_id) DO UPDATE
           SET last_opened_at = NOW()
         RETURNING lesson_id, started_at, last_opened_at, completed_at`,
        [tenant_id, sub, lesson.id],
      ))
    }
    const [state, sources] = await Promise.all([
      loadLearnerState(app, request),
      loadSources(app, request, catalog.lessons),
    ])
    const assembled = assembleTrail({
      trail,
      modules: catalog.modules,
      lessons: catalog.lessons,
      progressByLesson: new Map(state.progressRows.map((row) => [row.lesson_id, row])),
      bookmarks: new Set(state.bookmarkIds),
      sources,
    })
    const card = assembled.modules.flatMap((row) => row.lessons).find((row) => row.id === lesson.id)
    return {
      ...card,
      trail: { id: trail.id, slug: trail.slug, title: trail.title },
      module: { id: module.id, title: module.title, sort_order: module.sort_order },
      resume_path: resumePath(trail.slug, lesson.id),
      outline: assembled.modules,
    }
  })

  app.post('/v1/training/lessons/:id/start', { onRequest: readers }, async (request, reply) => {
    const catalog = await loadCatalog(app)
    const lesson = findLesson(catalog.lessons, request.params.id)
    if (!lesson) return reply.code(404).send({ error: 'Aula não encontrada' })
    const { tenant_id, sub } = request.user
    const result = await app.withTenant(tenant_id, (db) => db.query(
      `INSERT INTO training_lesson_progress (tenant_id, user_id, lesson_id, started_at, last_opened_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (tenant_id, user_id, lesson_id) DO UPDATE
         SET last_opened_at = NOW()
       RETURNING lesson_id, started_at, last_opened_at, completed_at`,
      [tenant_id, sub, lesson.id],
    ))
    return reply.code(200).send(result.rows[0])
  })

  app.post('/v1/training/lessons/:id/complete', { onRequest: readers }, async (request, reply) => {
    const catalog = await loadCatalog(app)
    const lesson = findLesson(catalog.lessons, request.params.id)
    if (!lesson) return reply.code(404).send({ error: 'Aula não encontrada' })
    const { tenant_id, sub } = request.user
    const result = await app.withTenant(tenant_id, (db) => db.query(
      `INSERT INTO training_lesson_progress (tenant_id, user_id, lesson_id, started_at, last_opened_at, completed_at)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW())
       ON CONFLICT (tenant_id, user_id, lesson_id) DO UPDATE
         SET completed_at = COALESCE(training_lesson_progress.completed_at, NOW()),
             last_opened_at = NOW()
       RETURNING lesson_id, started_at, last_opened_at, completed_at`,
      [tenant_id, sub, lesson.id],
    ))
    const module = catalog.modules.find((row) => row.id === lesson.module_id)
    const trail = catalog.trails.find((row) => row.id === module?.trail_id)
    const trailLessons = catalog.lessons
      .filter((row) => catalog.modules.find((item) => item.id === row.module_id)?.trail_id === trail?.id)
      .sort((a, b) => a.sort_order - b.sort_order)
    const index = trailLessons.findIndex((row) => row.id === lesson.id)
    const next = trailLessons[index + 1] ?? null
    return {
      ...result.rows[0],
      next_lesson_id: next?.id ?? null,
      resume_path: next ? resumePath(trail.slug, next.id) : null,
    }
  })

  app.get('/v1/training/progress', { onRequest: readers }, async (request) => {
    const catalog = await loadCatalog(app)
    const state = await loadLearnerState(app, request)
    const last = [...state.progressRows].sort((a, b) => new Date(b.last_opened_at) - new Date(a.last_opened_at))[0] ?? null
    const lastLesson = last ? catalog.lessons.find((lesson) => lesson.id === last.lesson_id) : null
    const module = catalog.modules.find((row) => row.id === lastLesson?.module_id)
    const trail = catalog.trails.find((row) => row.id === module?.trail_id)
    return {
      audience: audienceForRole(request.user.papel),
      last_lesson: lastLesson
        ? {
          id: lastLesson.id,
          title: lastLesson.title,
          state: last.completed_at ? 'completed' : 'in_progress',
          started_at: last.started_at,
          last_opened_at: last.last_opened_at,
          completed_at: last.completed_at,
          resume_path: resumePath(trail?.slug, lastLesson.id),
        }
        : null,
      items: state.progressRows,
    }
  })

  app.get('/v1/training/bookmarks', { onRequest: readers }, async (request) => {
    const catalog = await loadCatalog(app)
    const [state, sources] = await Promise.all([
      loadLearnerState(app, request),
      loadSources(app, request, catalog.lessons),
    ])
    const progressByLesson = new Map(state.progressRows.map((row) => [row.lesson_id, row]))
    const items = catalog.lessons
      .filter((lesson) => state.bookmarkIds.includes(lesson.id))
      .map((lesson) => hydrateLesson(lesson, {
        sources,
        progress: progressByLesson.get(lesson.id),
        bookmarked: true,
      }))
    return { items }
  })

  app.post('/v1/training/bookmarks', { onRequest: readers }, async (request, reply) => {
    const parsed = z.object({ lesson_id: uuid }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const catalog = await loadCatalog(app)
    const lesson = catalog.lessons.find((row) => row.id === parsed.data.lesson_id)
    if (!lesson) return reply.code(404).send({ error: 'Aula não encontrada' })
    const { tenant_id, sub } = request.user
    await app.withTenant(tenant_id, (db) => db.query(
      `INSERT INTO training_bookmarks (tenant_id, user_id, lesson_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id, lesson_id) DO NOTHING`,
      [tenant_id, sub, lesson.id],
    ))
    return reply.code(201).send({ lesson_id: lesson.id, bookmarked: true })
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
    const [state, sources] = await Promise.all([
      loadLearnerState(app, request),
      loadSources(app, request, catalog.lessons),
    ])
    return assembleTrail({
      trail,
      modules: catalog.modules,
      lessons: catalog.lessons,
      progressByLesson: new Map(state.progressRows.map((row) => [row.lesson_id, row])),
      bookmarks: new Set(state.bookmarkIds),
      sources,
    })
  })
}
