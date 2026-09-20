import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trainingRoutes } from '../src/routes/training.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const LESSON = 'a1111111-1111-4111-8111-111111111131'
const TRAIL = 'a1111111-1111-4111-8111-111111111111'
const MODULE = 'a1111111-1111-4111-8111-111111111121'

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
  module: { id: MODULE, trail_id: TRAIL, title: 'Preparação', sort_order: 1 },
  lesson: {
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
}

function buildApp({ papel = 'apresentadora', tenant = TENANT } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { sub: USER, tenant_id: tenant, papel }
  })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user?.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  const query = vi.fn(async (sql) => {
    if (sql.includes('FROM training_trails')) return { rows: [catalog.trail] }
    if (sql.includes('FROM training_modules')) return { rows: [catalog.module] }
    if (sql.includes('FROM training_lessons')) return { rows: [catalog.lesson] }
    if (sql.includes('FROM training_updates')) return { rows: [] }
    if (sql.includes('FROM manuais')) return { rows: [] }
    if (sql.includes('FROM knowledge_materials')) return { rows: [] }
    if (sql.includes('FROM training_lesson_progress')) return { rows: [] }
    if (sql.includes('FROM training_bookmarks') && sql.includes('SELECT')) return { rows: [] }
    if (sql.includes('INSERT INTO training_lesson_progress')) {
      return { rows: [{ lesson_id: LESSON, started_at: 's', last_opened_at: 's', completed_at: sql.includes('completed_at =') ? 'c' : null }] }
    }
    if (sql.includes('INSERT INTO training_bookmarks')) return { rows: [] }
    if (sql.includes('DELETE FROM training_bookmarks')) return { rows: [] }
    return { rows: [] }
  })
  app.decorate('db', { query })
  app.decorate('withTenant', async (id, fn) => fn({ query: (sql, params) => query(sql, params) }))
  return { app, query }
}

describe('training learner APIs', () => {
  afterEach(() => vi.restoreAllMocks())

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
    const { app, query } = buildApp()
    await app.register(trainingRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/training/home' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.title).toBe('Base de treinamento TikTok')
    expect(body.continue_learning).toBeNull()
    expect(body.start_here.slug).toBe('primeira-live-que-converte')
    expect(body.resume.has_started).toBe(false)
    expect(body.resume.path).toBe(`/conhecimento/trilhas/primeira-live-que-converte/aulas/${LESSON}`)
    expect(body.featured[0].id).toBe(LESSON)
    expect(JSON.stringify(body)).not.toMatch(/popular|certificado|streak|autoplay/i)
    expect(query.mock.calls.some((call) => String(call[0]).includes('training_trails'))).toBe(true)
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
    await app.close()
  })

  it('marks complete explicitly and points to the next lesson', async () => {
    const { app } = buildApp()
    await app.register(trainingRoutes)
    const response = await app.inject({ method: 'POST', url: `/v1/training/lessons/${LESSON}/complete` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ lesson_id: LESSON, completed_at: 'c' })
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

  it('opens a lesson as a deep-link payload with outline, not a syllabus-only redirect', async () => {
    const { app } = buildApp()
    await app.register(trainingRoutes)
    const response = await app.inject({ method: 'GET', url: `/v1/training/lessons/${LESSON}` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: LESSON,
      resume_path: `/conhecimento/trilhas/primeira-live-que-converte/aulas/${LESSON}`,
      trail: { slug: 'primeira-live-que-converte' },
    })
    expect(response.json().outline[0].title).toBe('Preparação')
    await app.close()
  })
})
