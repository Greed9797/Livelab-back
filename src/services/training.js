export const TRAINING_READERS = [
  'franqueador_master', 'franqueado', 'gerente', 'gerente_comercial',
  'financeiro', 'financeiro_readonly', 'auditor', 'suporte', 'operacional',
  'produtor_live', 'marketing', 'comercial_readonly', 'apresentador', 'apresentadora',
]

export const AUDIENCE_BY_ROLE = {
  apresentador: 'apresentadora',
  apresentadora: 'apresentadora',
  operacional: 'operacao',
  produtor_live: 'operacao',
  suporte: 'operacao',
  gerente_comercial: 'comercial',
  marketing: 'comercial',
  comercial_readonly: 'comercial',
  financeiro: 'gestor',
  financeiro_readonly: 'gestor',
  auditor: 'gestor',
  franqueado: 'gestor',
  gerente: 'gestor',
  franqueador_master: 'gestor',
}

const STARTER_SLUG = 'primeira-live-que-converte'

export function audienceForRole(papel) {
  return AUDIENCE_BY_ROLE[papel] ?? 'apresentadora'
}

export function resumePath(trailSlug, lessonId) {
  if (!trailSlug || !lessonId) return null
  return `/conhecimento/trilhas/${trailSlug}/aulas/${lessonId}`
}

export function progressState(row) {
  if (row?.completed_at) return 'completed'
  if (row?.started_at) return 'in_progress'
  return 'not_started'
}

export function freshness({ published_at, updated_at }, now = new Date()) {
  const published = published_at ? new Date(published_at) : null
  const updated = updated_at ? new Date(updated_at) : null
  if (!published && !updated) return null
  const latest = updated && published && updated > published ? updated : (updated || published)
  const ageMs = now.getTime() - latest.getTime()
  const fourteenDays = 14 * 24 * 60 * 60 * 1000
  if (updated && published && updated.getTime() - published.getTime() > 24 * 60 * 60 * 1000) {
    return ageMs <= fourteenDays * 2 ? 'atualizado' : null
  }
  if (published && now.getTime() - published.getTime() <= fourteenDays) return 'novo'
  return null
}

export function trailProgress(lessons, progressByLesson) {
  const required = lessons.filter((lesson) => lesson.required !== false)
  const completed = required.filter((lesson) => progressByLesson.get(lesson.id)?.completed_at)
  const total = required.length
  const done = completed.length
  return {
    required_lessons: total,
    completed_lessons: done,
    progress_pct: total === 0 ? 0 : Math.round((done / total) * 100),
  }
}

export function nextRequiredLesson(lessons, progressByLesson, fromLessonId = null) {
  const required = lessons.filter((lesson) => lesson.required !== false)
  const start = fromLessonId ? required.findIndex((lesson) => lesson.id === fromLessonId) + 1 : 0
  for (let i = start; i < required.length; i++) {
    if (!progressByLesson.get(required[i].id)?.completed_at) return required[i]
  }
  return required.find((lesson) => !progressByLesson.get(lesson.id)?.completed_at) ?? null
}

export function orderTrailLessons(lessons, modules, trailId) {
  const moduleById = new Map(modules.map((row) => [row.id, row]))
  return lessons
    .filter((lesson) => moduleById.get(lesson.module_id)?.trail_id === trailId)
    .sort((a, b) => {
      const modA = moduleById.get(a.module_id)?.sort_order ?? 0
      const modB = moduleById.get(b.module_id)?.sort_order ?? 0
      return modA - modB || a.sort_order - b.sort_order
    })
}

export function nextLessonInTrail(lessons, modules, lesson) {
  const module = modules.find((row) => row.id === lesson.module_id)
  const ordered = orderTrailLessons(lessons, modules, module?.trail_id)
  const index = ordered.findIndex((row) => row.id === lesson.id)
  return index >= 0 ? ordered[index + 1] ?? null : null
}

export function continueTarget({ lessons, modules, trails, progressRows }) {
  const progressByLesson = new Map(progressRows.map((row) => [row.lesson_id, row]))
  const last = [...progressRows].sort((a, b) => new Date(b.last_opened_at) - new Date(a.last_opened_at))[0]
  if (!last) return null
  const current = lessons.find((lesson) => lesson.id === last.lesson_id)
  if (!current) return null
  const module = modules.find((row) => row.id === current.module_id)
  const trail = trails.find((row) => row.id === module?.trail_id)
  const trailLessons = orderTrailLessons(lessons, modules, trail?.id)
  const resumeLesson = last.completed_at
    ? nextRequiredLesson(trailLessons, progressByLesson, last.lesson_id)
    : current
  if (!resumeLesson || !trail) return null
  const resumeModule = modules.find((row) => row.id === resumeLesson.module_id)
  return {
    trail,
    module: resumeModule,
    lesson: resumeLesson,
    resume_path: resumePath(trail.slug, resumeLesson.id),
    progress: trailProgress(trailLessons, progressByLesson),
  }
}

function matchesAudience(item, audience) {
  const roles = item.audience_roles ?? []
  return roles.length === 0 || roles.includes(audience)
}

function matchesFilters(item, filters = {}) {
  const { role, level, topic, platform, format } = filters
  if (role && !matchesAudience(item, role)) return false
  if (level && item.difficulty && item.difficulty !== level) return false
  if (topic && !(item.topics ?? []).includes(topic)) return false
  if (platform && !(item.platforms ?? []).includes(platform)) return false
  if (format && item.format && item.format !== format) return false
  return true
}

export function pickRecommended({ lessons, audience, progressByLesson, limit = 6 }) {
  return lessons
    .filter((lesson) => matchesAudience(lesson, audience))
    .filter((lesson) => progressState(progressByLesson.get(lesson.id)) !== 'completed')
    .sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || a.sort_order - b.sort_order)
    .slice(0, limit)
}

const SAFE_VIDEO_ID = /^[A-Za-z0-9_-]{1,200}$/

export function canonicalVideoUrl(provider, id) {
  if (!id || !SAFE_VIDEO_ID.test(String(id))) return null
  if (provider === 'youtube') return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
  if (provider === 'panda') return `https://panda.video/${encodeURIComponent(id)}`
  return null
}

export function sourceVideoUrl(source) {
  if (!source) return null
  if (source.video_url) return source.video_url
  return canonicalVideoUrl(source.video_provider, source.video_id)
}

export function lessonMaterial(source) {
  if (!source) return null
  const title = source.title ?? source.titulo ?? null
  return {
    id: source.id,
    slug: source.slug,
    titulo: title,
    title,
    excerpt: source.excerpt ?? null,
    content_markdown: source.content_markdown ?? null,
    external_url: source.external_url ?? source.url ?? null,
    video_provider: source.video_provider ?? 'none',
    video_id: source.video_id ?? null,
    video_url: sourceVideoUrl(source),
    cover_image_url: source.cover_image_url ?? null,
    duration_minutes: source.duration_minutes ?? source.estimated_read_minutes ?? null,
    status: 'published',
  }
}

export function hydrateLesson(lesson, { sources, progress, bookmarked, now, includeContent = false } = {}) {
  const source = resolveSource(lesson, sources)
  const publishedAt = source?.published_at ?? null
  const updatedAt = source?.updated_at ?? source?.atualizado_em ?? null
  const material = includeContent ? lessonMaterial(source) : null
  return {
    id: lesson.id,
    title: source?.title ?? source?.titulo ?? lesson.title,
    excerpt: source?.excerpt ?? lesson.excerpt,
    outcome: lesson.outcome,
    duration_minutes: source?.duration_minutes ?? source?.estimated_read_minutes ?? lesson.duration_minutes,
    difficulty: source?.difficulty ?? lesson.difficulty,
    format: lesson.format,
    audience_roles: (source?.audience_roles?.length ? source.audience_roles : lesson.audience_roles) ?? [],
    topics: (source?.topics?.length ? source.topics : lesson.topics) ?? [],
    platforms: (source?.platforms?.length ? source.platforms : lesson.platforms) ?? ['tiktok'],
    objectives: (source?.objectives?.length ? source.objectives : lesson.objectives) ?? [],
    prerequisites: (source?.prerequisites?.length ? source.prerequisites : lesson.prerequisites) ?? [],
    cover_image_url: source?.cover_image_url ?? null,
    featured: Boolean(lesson.featured || source?.featured || source?.destaque),
    required: lesson.required !== false,
    freshness: freshness({ published_at: publishedAt, updated_at: updatedAt }, now),
    published_at: publishedAt,
    updated_at: updatedAt,
    source: source
      ? {
        kind: source.origin_kind,
        id: source.id,
        slug: source.slug,
        origin: source.origin_kind === 'unit_material' ? 'unidade' : 'rede',
      }
      : null,
    content_available: Boolean(source),
    ...(includeContent
      ? {
        content_markdown: material?.content_markdown ?? null,
        video_provider: material?.video_provider ?? 'none',
        video_id: material?.video_id ?? null,
        video_url: material?.video_url ?? null,
        external_url: material?.external_url ?? null,
        material,
      }
      : {}),
    progress: {
      state: progressState(progress),
      started_at: progress?.started_at ?? null,
      last_opened_at: progress?.last_opened_at ?? null,
      completed_at: progress?.completed_at ?? null,
    },
    bookmarked: Boolean(bookmarked),
    module_id: lesson.module_id,
    sort_order: lesson.sort_order,
  }
}

function resolveSource(lesson, sources = { network: new Map(), unit: new Map() }) {
  if (lesson.source_kind === 'unit_material' || lesson.source_title) {
    const unit = sources.unit.get(normalizeTitle(lesson.source_title)) || sources.unit.get(lesson.source_slug)
    if (unit) return { ...unit, origin_kind: 'unit_material' }
  }
  if (lesson.source_kind === 'network_article' || lesson.source_slug) {
    const network = sources.network.get(lesson.source_slug)
    if (network) return { ...network, origin_kind: 'network_article' }
  }
  return null
}

export function normalizeTitle(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

export function assembleTrail({ trail, modules, lessons, progressByLesson, bookmarks, sources, now }) {
  const trailModules = modules
    .filter((module) => module.trail_id === trail.id)
    .sort((a, b) => a.sort_order - b.sort_order)
  const trailLessons = []
  const hydratedModules = trailModules.map((module) => {
    const moduleLessons = lessons
      .filter((lesson) => lesson.module_id === module.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((lesson) => {
        const card = hydrateLesson(lesson, {
          sources,
          progress: progressByLesson.get(lesson.id),
          bookmarked: bookmarks?.has(lesson.id),
          now,
        })
        trailLessons.push({ ...lesson, required: lesson.required !== false })
        return card
      })
    return { id: module.id, title: module.title, sort_order: module.sort_order, lessons: moduleLessons }
  })
  const flat = hydratedModules.flatMap((module) => module.lessons)
  flat.forEach((lesson, index) => {
    lesson.next_lesson_id = flat[index + 1]?.id ?? null
    const module = hydratedModules.find((row) => row.lessons.some((item) => item.id === lesson.id))
    lesson.position_label = `${module?.title ?? 'Módulo'} · Aula ${module.lessons.findIndex((item) => item.id === lesson.id) + 1} de ${module.lessons.length}`
  })
  return {
    id: trail.id,
    slug: trail.slug,
    title: trail.title,
    outcome: trail.outcome,
    audience_roles: trail.audience_roles ?? [],
    topics: trail.topics ?? [],
    difficulty: trail.difficulty,
    duration_minutes: trail.duration_minutes,
    featured: Boolean(trail.featured),
    module_count: hydratedModules.length,
    lesson_count: flat.length,
    ...trailProgress(trailLessons, progressByLesson),
    resume_path: resumePath(trail.slug, nextRequiredLesson(trailLessons, progressByLesson)?.id ?? flat[0]?.id),
    modules: hydratedModules,
  }
}

export function assembleHome({
  papel,
  trails,
  modules,
  lessons,
  progressRows,
  bookmarkIds,
  sources,
  curatedUpdates,
  derivedUpdates,
  now = new Date(),
  filters = {},
}) {
  const audience = audienceForRole(papel)
  const recommendedAudience = filters.role || audience
  const progressByLesson = new Map(progressRows.map((row) => [row.lesson_id, row]))
  const bookmarks = new Set(bookmarkIds)
  const orderedLessons = [...lessons].sort((a, b) => {
    const modA = modules.find((row) => row.id === a.module_id)?.sort_order ?? 0
    const modB = modules.find((row) => row.id === b.module_id)?.sort_order ?? 0
    return modA - modB || a.sort_order - b.sort_order
  })
  const visibleLessons = orderedLessons.filter((lesson) => matchesFilters({
    ...lesson,
    audience_roles: lesson.audience_roles,
  }, { ...filters, role: recommendedAudience }))
  const starter = trails.find((trail) => trail.slug === STARTER_SLUG) ?? trails[0] ?? null
  const assembledStarter = starter
    ? assembleTrail({ trail: starter, modules, lessons: orderedLessons, progressByLesson, bookmarks, sources, now })
    : null
  const cont = continueTarget({ lessons: orderedLessons, modules, trails, progressRows })
  const continueCard = cont
    ? {
      ...hydrateLesson(cont.lesson, {
        sources,
        progress: progressByLesson.get(cont.lesson.id),
        bookmarked: bookmarks.has(cont.lesson.id),
        now,
      }),
      trail: { id: cont.trail.id, slug: cont.trail.slug, title: cont.trail.title },
      module: { id: cont.module?.id, title: cont.module?.title },
      resume_path: cont.resume_path,
      progress_pct: cont.progress.progress_pct,
      completed_lessons: cont.progress.completed_lessons,
      required_lessons: cont.progress.required_lessons,
    }
    : null

  return {
    title: 'Base de treinamento TikTok',
    audience,
    resume: continueCard
      ? { has_started: true, lesson_id: continueCard.id, trail_slug: continueCard.trail.slug, path: continueCard.resume_path }
      : { has_started: false, lesson_id: assembledStarter?.modules[0]?.lessons[0]?.id ?? null, trail_slug: assembledStarter?.slug ?? null, path: assembledStarter?.resume_path ?? null },
    continue_learning: continueCard,
    start_here: continueCard ? null : assembledStarter,
    recommended: pickRecommended({ lessons: visibleLessons, audience: recommendedAudience, progressByLesson }).map((lesson) => hydrateLesson(lesson, {
      sources,
      progress: progressByLesson.get(lesson.id),
      bookmarked: bookmarks.has(lesson.id),
      now,
    })),
    featured: orderedLessons.filter((lesson) => lesson.featured).slice(0, 4).map((lesson) => hydrateLesson(lesson, {
      sources,
      progress: progressByLesson.get(lesson.id),
      bookmarked: bookmarks.has(lesson.id),
      now,
    })),
    starter_trail: assembledStarter,
    updates: mergeUpdates(curatedUpdates, derivedUpdates, { audience, now }),
  }
}

export function mergeUpdates(curated = [], derived = [], { audience, now } = {}) {
  const cards = [
    ...curated.filter((row) => row.is_active !== false).map((row) => ({
      kind: 'atualizacao',
      id: row.id,
      title: row.title,
      what_changed: row.what_changed,
      what_to_do_today: row.what_to_do_today,
      effective_on: row.effective_on,
      audience_roles: row.audience_roles ?? [],
      topics: row.topics ?? [],
      official_url: row.official_url ?? null,
      owner: row.owner ?? null,
      last_reviewed_at: row.last_reviewed_at ?? null,
      next_review_at: row.next_review_at ?? null,
      lesson_id: row.lesson_id ?? null,
      source: row.network_slug ? { kind: 'network_article', slug: row.network_slug, origin: 'rede' } : null,
      featured: Boolean(row.featured),
      published_at: row.published_at,
    })),
    ...derived.map((row) => ({
      kind: freshness(row, now) === 'atualizado' ? 'atualizado' : 'novo',
      id: row.id,
      title: row.title ?? row.titulo,
      what_changed: row.excerpt ?? null,
      what_to_do_today: null,
      effective_on: null,
      audience_roles: row.audience_roles ?? [],
      topics: row.topics ?? [],
      official_url: null,
      owner: null,
      last_reviewed_at: null,
      next_review_at: null,
      lesson_id: null,
      source: {
        kind: row.origin_kind,
        id: row.id,
        slug: row.slug,
        origin: row.origin_kind === 'unit_material' ? 'unidade' : 'rede',
      },
      featured: Boolean(row.featured || row.destaque),
      published_at: row.published_at ?? row.updated_at,
      freshness: freshness(row, now),
    })),
  ]
  return cards
    .filter((card) => !audience || matchesAudience(card, audience) || card.kind === 'atualizacao')
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
    .slice(0, 8)
}

export function filterCatalog(items, filters) {
  return items.filter((item) => matchesFilters(item, filters))
}
