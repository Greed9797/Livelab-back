import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'
import { trainingRoutes } from '../src/routes/training.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const LESSON = 'a1111111-1111-4111-8111-111111111131'
const LESSON_2 = 'a1111111-1111-4111-8111-111111111132'
const LESSON_3 = 'a1111111-1111-4111-8111-111111111133'
const TRAIL = 'a1111111-1111-4111-8111-111111111111'
const MODULE = 'a1111111-1111-4111-8111-111111111121'
const MODULE_2 = 'a1111111-1111-4111-8111-111111111122'

const catalog = {
  trail: {
    id: TRAIL,
    slug: 'primeira-live-que-converte',
    title: 'Primeira Live que converte',
    outcome: 'Preparar a primeira live',
    audience_roles: ['apresentadora'],
    topics: ['live'],
    difficulty: 'iniciante',
    duration_minutes: 28,
    featured: true,
    is_active: true,
    sort_order: 1,
  },
  modules: [
    { id: MODULE, trail_id: TRAIL, title: 'Preparação', sort_order: 1 },
    { id: MODULE_2, trail_id: TRAIL, title: 'Ao vivo', sort_order: 2 },
  ],
  lessons: [
    {
      id: LESSON,
      module_id: MODULE,
      sort_order: 1,
      required: true,
      title: 'Checklist técnico antes de entrar ao vivo',
      excerpt: 'Checagem',
      outcome: 'Chegar pronta',
      duration_minutes: 6,
      difficulty: 'iniciante',
      format: 'checklist',
      audience_roles: ['apresentadora'],
      topics: ['live'],
      platforms: ['tiktok'],
      objectives: ['Conferir áudio'],
      prerequisites: [],
      featured: true,
      source_kind: 'network_article',
      source_slug: 'como-iniciar-uma-live-com-sucesso-seed',
      source_title: 'Como iniciar uma live com sucesso',
    },
    {
      id: LESSON_2,
      module_id: MODULE,
      sort_order: 2,
      required: true,
      title: 'Oferta, estoque e cupom no TikTok Shop',
      excerpt: 'Oferta',
      outcome: 'Estoque conferido',
      duration_minutes: 5,
      difficulty: 'iniciante',
      format: 'checklist',
      audience_roles: ['apresentadora'],
      topics: ['shop'],
      platforms: ['tiktok'],
      objectives: [],
      prerequisites: [],
      featured: false,
      source_kind: 'unit_material',
      source_slug: null,
      source_title: 'Oferta, estoque e cupom no TikTok Shop',
    },
    {
      id: LESSON_3,
      module_id: MODULE_2,
      sort_order: 1,
      required: true,
      title: 'Hook dos primeiros 30 segundos',
      excerpt: 'Hook',
      outcome: 'Segurar a sala',
      duration_minutes: 4,
      difficulty: 'iniciante',
      format: 'video',
      audience_roles: ['apresentadora'],
      topics: ['live'],
      platforms: ['tiktok'],
      objectives: [],
      prerequisites: [],
      featured: true,
      source_kind: 'network_article',
      source_slug: 'como-iniciar-uma-live-com-sucesso-seed',
      source_title: 'Como iniciar uma live com sucesso',
    },
  ],
}

function buildApp({
  papel = 'apresentadora',
  tenant = TENANT,
  progressRows = [],
  bookmarkIds = [],
  manuais = [],
  unitMaterials = [],
} = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { sub: USER, tenant_id: tenant, papel }
  })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user?.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  const query = vi.fn(async (sql) => {
    const text = String(sql)
    if (text.includes('INSERT INTO training_lesson_progress')) {
      return { rows: [{ lesson_id: LESSON, started_at: 's', last_opened_at: 's', completed_at: text.includes('completed_at =') ? 'c' : null }] }
    }
    if (text.includes('INSERT INTO training_bookmarks')) return { rows: [] }
    if (text.includes('DELETE FROM training_bookmarks')) return { rows: [] }
    if (text.includes('ORDER BY module.sort_order')) {
      return {
        rows: catalog.lessons.map((lesson) => ({ id: lesson.id, slug: catalog.trail.slug })),
      }
    }
    if (text.includes('SELECT id FROM training_lessons')) {
      const id = catalog.lessons[0].id
      return { rows: [{ id }] }
    }
    if (text.includes('SELECT l.id, l.title')) {
      return { rows: [{ id: LESSON, title: catalog.lessons[0].title, slug: catalog.trail.slug }] }
    }
    if (text.includes('json_agg') && text.includes('training_trails')) {
      return {
        rows: [{
          trails: [catalog.trail],
          modules: catalog.modules,
          lessons: catalog.lessons,
          updates: [],
        }],
      }
    }
    if (text.includes('json_build_object') || text.includes('training_lesson_progress p')) {
      return {
        rows: [{
          progress: progressRows,
          bookmark_ids: bookmarkIds,
          unit_materials: unitMaterials,
          derived_unit: [],
        }],
      }
    }
    if (text.includes('FROM manuais')) return { rows: manuais }
    if (text.includes('FROM knowledge_materials')) return { rows: unitMaterials }
    if (text.includes('FROM training_lesson_progress')) return { rows: progressRows }
    if (text.includes('FROM training_bookmarks') && text.includes('SELECT')) {
      return { rows: bookmarkIds.map((lesson_id) => ({ lesson_id })) }
    }
    return { rows: [] }
  })
  const withTenant = vi.fn(async (_id, fn) => fn({ query: (sql, params) => query(sql, params) }))
  app.decorate('db', { query })
  app.decorate('withTenant', withTenant)
  return { app, query, withTenant }
}

describe('training learner APIs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    _clearDashboardCache()
  })

  it('rejects client and automation before touching learner state', async () => {
    for (const papel of ['cliente_parceiro', 'automacao']) {
      const { app, query } = buildApp({ papel })
      await app.register(trainingRoutes)
      const response = await app.inject({ method: 'GET', url: '/v1/training/home' })
      expect(response.statusCode).toBe(403)
      expect(query).not.toHaveBeenCalled()
      await app.close()
    }
  })

  it('returns start-here and a resume deep link when there is no history', async () => {
    const { app, query, withTenant } = buildApp()
    await app.register(trainingRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/training/home' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.title).toBe('Base de treinamento TikTok')
    expect(body.continue_learning).toBeNull()
    expect(body.start_here.slug).toBe('primeira-live-que-converte')
    expect(body.starter_trail.slug).toBe('primeira-live-que-converte')
    expect(body.resume.has_started).toBe(false)
    expect(body.resume.path).toBe(`/conhecimento/trilhas/primeira-live-que-converte/aulas/${LESSON}`)
    expect(body.featured[0].id).toBe(LESSON)
    expect(JSON.stringify(body)).not.toMatch(/popular|certificado|streak|autoplay/i)
    expect(query.mock.calls.filter((call) => String(call[0]).includes('training_trails'))).toHaveLength(1)
    expect(withTenant).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('reuses the catalog cache on the next home request', async () => {
    const { app, query } = buildApp()
    await app.register(trainingRoutes)
    await app.inject({ method: 'GET', url: '/v1/training/home' })
    await app.inject({ method: 'GET', url: '/v1/training/home' })
    expect(query.mock.calls.filter((call) => String(call[0]).includes('training_trails'))).toHaveLength(1)
    await app.close()
  })

  it('changes recommended when ?role= overrides the JWT audience', async () => {
    const { app } = buildApp({ papel: 'franqueado' })
    await app.register(trainingRoutes)
    const gestor = await app.inject({ method: 'GET', url: '/v1/training/home' })
    const apresentadora = await app.inject({ method: 'GET', url: '/v1/training/home?role=apresentadora' })
    expect(gestor.json().audience).toBe('gestor')
    expect(gestor.json().recommended.map((row) => row.id)).not.toEqual(
      apresentadora.json().recommended.map((row) => row.id),
    )
    expect(apresentadora.json().recommended.map((row) => row.id)).toEqual([LESSON, LESSON_3, LESSON_2])
    await app.close()
  })

  it('scopes progress writes to tenant + user and does not auto-complete on start', async () => {
    const { app, query } = buildApp()
    await app.register(trainingRoutes)
    const started = await app.inject({ method: 'POST', url: `/v1/training/lessons/${LESSON}/start` })
    expect(started.statusCode).toBe(200)
    expect(started.json().completed_at).toBeNull()
    const write = query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO training_lesson_progress'))
    expect(write[1]).toEqual([TENANT, USER, LESSON])
    expect(write[0]).not.toContain('70')
    expect(write[0]).toMatch(/last_opened_at = NOW\(\)/)
    expect(query.mock.calls.some((call) => String(call[0]).includes('json_agg') && String(call[0]).includes('training_trails'))).toBe(false)
    await app.close()
  })

  it('marks complete explicitly and points to the next lesson by module then sort', async () => {
    const { app, query } = buildApp()
    await app.register(trainingRoutes)
    const response = await app.inject({ method: 'POST', url: `/v1/training/lessons/${LESSON}/complete` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      lesson_id: LESSON,
      completed_at: 'c',
      next_lesson_id: LESSON_2,
      resume_path: `/conhecimento/trilhas/primeira-live-que-converte/aulas/${LESSON_2}`,
    })
    const orderSql = query.mock.calls.find((call) => String(call[0]).includes('ORDER BY module.sort_order'))
    expect(orderSql[0]).toMatch(/module\.sort_order,\s*l\.sort_order/)
    await app.close()
  })

  it('bookmarks a lesson for the current tenant user', async () => {
    const { app, query } = buildApp()
    await app.register(trainingRoutes)
    const created = await app.inject({ method: 'POST', url: '/v1/training/bookmarks', payload: { lesson_id: LESSON } })
    expect(created.statusCode).toBe(201)
    const write = query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO training_bookmarks'))
    expect(write[1]).toEqual([TENANT, USER, LESSON])
    const removed = await app.inject({ method: 'DELETE', url: `/v1/training/bookmarks/${LESSON}` })
    expect(removed.statusCode).toBe(204)
    await app.close()
  })

  it('returns empty bookmarks without loading the catalog', async () => {
    const { app, query, withTenant } = buildApp()
    await app.register(trainingRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/training/bookmarks' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [] })
    expect(query.mock.calls.some((call) => String(call[0]).includes('training_trails'))).toBe(false)
    expect(withTenant).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('opens a lesson as a deep-link payload with outline, video and markdown', async () => {
    const { app, withTenant } = buildApp({
      manuais: [{
        id: 'manual-1',
        slug: 'como-iniciar-uma-live-com-sucesso-seed',
        titulo: 'Como iniciar uma live com sucesso',
        excerpt: 'Checagem',
        content_markdown: '# Olá da aula',
        video_provider: 'youtube',
        video_url: 'https://www.youtube.com/watch?v=abc_123',
        published_at: '2026-09-18T12:00:00Z',
      }],
    })
    await app.register(trainingRoutes)
    const response = await app.inject({ method: 'GET', url: `/v1/training/lessons/${LESSON}` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: LESSON,
      resume_path: `/conhecimento/trilhas/primeira-live-que-converte/aulas/${LESSON}`,
      trail: { slug: 'primeira-live-que-converte' },
      content_markdown: '# Olá da aula',
      video_provider: 'youtube',
      video_url: 'https://www.youtube.com/watch?v=abc_123',
      material: {
        content_markdown: '# Olá da aula',
        video_url: 'https://www.youtube.com/watch?v=abc_123',
      },
    })
    expect(response.json().outline[0].title).toBe('Preparação')
    expect(withTenant).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
