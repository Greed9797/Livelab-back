import fs from 'node:fs'
import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { trainingRoutes } from '../src/routes/training.js'
import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '11111111-1111-4111-8111-222222222222'
const MASTER = '22222222-2222-4222-8222-222222222222'
const LEARNER = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'
const IDLE = '55555555-5555-4555-8555-555555555555'
let db, app, trail, first, second

async function request(method, url, payload, role = 'franqueador_master', tenant = A, user = MASTER) {
  return app.inject({ method, url: `/v1/training${url}`, payload,
    headers: { 'x-test-role': role, 'x-test-tenant': tenant, 'x-test-user': user } })
}

function checkpoint(intervals, revision = 0, position = 30, version = 1) {
  return { video_version: version, duration_seconds: 100.5, last_position_seconds: position,
    position_revision: revision, intervals, playback_started: true }
}

describe.sequential('training video actual routes and SQL', () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE TABLE tenants (id uuid PRIMARY KEY);
      CREATE TABLE users (id uuid PRIMARY KEY, tenant_id uuid, nome text, email text, papel text, ativo boolean DEFAULT true);
      CREATE TABLE manuais (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text, titulo text, excerpt text, cover_image_url text, estimated_read_minutes int, destaque boolean DEFAULT false, published_at timestamptz, atualizado_em timestamptz DEFAULT now(), content_markdown text, video_provider text, video_url text, url text DEFAULT '', status text DEFAULT 'published');
      CREATE TABLE knowledge_materials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,slug text,title text,excerpt text,status text DEFAULT 'published',published_at timestamptz,updated_at timestamptz DEFAULT now(),content_markdown text,video_provider text,video_id text,external_url text);
      INSERT INTO tenants VALUES ('${A}'),('${B}');
      INSERT INTO users VALUES ('${MASTER}','${A}','Master','master@example.invalid','franqueador_master',true),('${LEARNER}','${A}','Aluna','learner@example.invalid','apresentadora',true),('${OTHER}','${B}','Outra unidade','other@example.invalid','apresentadora',true),('${IDLE}','${A}','Nunca iniciou','idle@example.invalid','operacional',true);
    `)
    for (const name of ['157_training_p0.sql', '158_training_empty_lesson.sql', '186_training_video.sql']) {
      await db.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
    }
    const client = { query: (sql, values) => db.query(sql, values), release() {} }
    app = Fastify()
    app.decorate('db', { query: client.query, pool: { connect: async () => client } })
    app.decorate('authenticate', async (req) => {
      req.user = { papel: req.headers['x-test-role'], tenant_id: req.headers['x-test-tenant'], sub: req.headers['x-test-user'] }
    })
    app.decorate('requirePapel', (roles) => async (req, reply) => {
      if (!roles.includes(req.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    let queue = Promise.resolve()
    app.decorate('withTenant', (tenant, fn) => {
      const result = queue.then(async () => {
        await db.query("SELECT set_config('app.tenant_id',$1,false)", [tenant])
        return fn(client)
      })
      queue = result.catch(() => {})
      return result
    })
    _clearDashboardCache()
    await app.register(trainingRoutes)
    await app.ready()
  }, 180000)
  afterAll(async () => { await app?.close(); await db?.close(); _clearDashboardCache() })

  it('restricts global management, creates covers, appends lessons and validates video sources', async () => {
    expect((await request('POST', '/admin/trails', { title: 'Negado' }, 'gerente')).statusCode).toBe(403)
    const created = await request('POST', '/admin/trails', { title: 'Trilha de teste', cover_image_url: 'https://example.invalid/trail.png' })
    expect(created.statusCode).toBe(201)
    trail = created.json()
    expect(trail.cover_image_url).toBe('https://example.invalid/trail.png')
    const youtube = await request('POST', `/admin/trails/${trail.id}/lessons`, { title: 'YouTube', cover_image_url: 'https://example.invalid/lesson.png', video_provider: 'youtube', video_input: 'M7lc1UVf-VE', video_library_id: null })
    expect(youtube.statusCode).toBe(201)
    first = youtube.json()
    expect(first.video_id).toBe('M7lc1UVf-VE')
    expect(first.cover_image_url).toBe('https://example.invalid/lesson.png')
    const panda = await request('POST', `/admin/trails/${trail.id}/lessons`, { title: 'Panda', video_provider: 'panda', video_input: 'c47450b0-fa57-40b8-aee0-ae7ade8293db', video_library_id: 'vz-ee87ef4f-55f' })
    expect(panda.statusCode).toBe(201)
    second = panda.json()
    expect(second.video_library_id).toBe('vz-ee87ef4f-55f')
    for (const input of ['<script>alert(1)</script>', 'https://youtube.com.evil.invalid/watch?v=M7lc1UVf-VE', 'https://user:pass@youtube.com/watch?v=M7lc1UVf-VE']) {
      expect((await request('POST', `/admin/trails/${trail.id}/lessons`, { title: 'Inválido', video_provider: 'youtube', video_input: input })).statusCode).toBe(400)
    }
  })

  it('orders the reader and rejects incomplete or foreign lesson reorder without partial updates', async () => {
    expect((await request('POST', `/admin/trails/${trail.id}/lessons/reorder`, { ids: [second.id, first.id] })).statusCode).toBe(200)
    const ordered = (await request('GET', `/trails/${trail.slug}`)).json()
    expect((ordered.ordered_lessons ?? ordered.modules.flatMap((m) => m.lessons)).map((l) => l.id)).toEqual([second.id, first.id])
    expect((await request('PATCH', `/admin/lessons/${second.id}`, { title: 'Panda atualizado', trail_id: trail.id })).statusCode).toBe(200)
    const edited = (await request('GET', `/trails/${trail.slug}`)).json()
    expect((edited.ordered_lessons ?? edited.modules.flatMap((m) => m.lessons)).map((l) => l.id)).toEqual([second.id, first.id])
    const invalid = await request('POST', `/admin/trails/${trail.id}/lessons/reorder`, { ids: [first.id, IDLE] })
    expect([400, 404, 409]).toContain(invalid.statusCode)
    const after = (await request('GET', `/trails/${trail.slug}`)).json()
    expect((after.ordered_lessons ?? after.modules.flatMap((m) => m.lessons)).map((l) => l.id)).toEqual([second.id, first.id])
  })

  it('does not start on open and includes eligible never-started people in scoped reports', async () => {
    const opened = await request('GET', `/lessons/${first.id}?start=true`, undefined, 'apresentadora', A, LEARNER)
    expect(opened.statusCode).toBe(200)
    expect(opened.json().progress.state).toBe('not_started')
    expect((await request('POST', `/lessons/${first.id}/complete`, undefined, 'apresentadora', A, LEARNER)).statusCode).toBe(409)
    expect((await request('GET', '/reports', undefined, 'apresentadora', A, LEARNER)).statusCode).toBe(403)
    const report = await request('GET', `/reports?trail_id=${trail.id}`, undefined, 'gerente')
    expect(report.statusCode).toBe(200)
    expect(report.json().items.some((r) => r.user_id === IDLE && r.state === 'not_started')).toBe(true)
    expect(report.json().items.some((r) => r.user_id === OTHER)).toBe(false)
    expect(report.json().users.some((u) => u.id === IDLE)).toBe(true)
  })

  it('unions repeated and interleaved-tab coverage, keeps skipped sections and stale positions separate, and completes only at 90%', async () => {
    const save = (body) => request('POST', `/lessons/${first.id}/progress`, body, 'apresentadora', A, LEARNER)
    const initial = await save(checkpoint([[0, 30]], 0, 30))
    expect(initial.statusCode).toBe(200)
    expect(initial.json().state).toBe('in_progress')
    expect(initial.json().watched_percent).toBeCloseTo(30 / 100.5 * 100, 1)
    const replay = await save(checkpoint([[0, 30]], 0, 5))
    expect(replay.json().watched_percent).toBe(initial.json().watched_percent)
    expect(replay.json().last_position_seconds).toBe(30)
    const secondTab = await save(checkpoint([[60, 90]], 0, 90))
    expect(secondTab.json().watched_percent).toBeCloseTo(60 / 100.5 * 100, 1)
    expect(secondTab.json().completed_at).toBeNull()
    const below = await save(checkpoint([[30, 60], [90, 90.44]], secondTab.json().position_revision, 90.44))
    expect(below.json().completed_at).toBeNull()
    const complete = await save(checkpoint([[90.44, 90.45]], below.json().position_revision, 90.45))
    expect(complete.json().state).toBe('completed')
    expect(complete.json().completed_at).toBeTruthy()
    expect((await request('GET', `/trails/${trail.slug}`, undefined, 'apresentadora', A, LEARNER)).json().progress_pct).toBe(50)
    expect((await request('GET', `/reports?user_id=${LEARNER}&trail_id=${trail.id}`, undefined, 'gerente')).json().items.filter((r) => r.lesson_id === first.id)[0].state).toBe('completed')
    expect((await save({ ...checkpoint([[0, 1]]), user_id: OTHER })).statusCode).toBe(400)
  })

  it('preserves SDK fractional duration through a final checkpoint without rejecting the end of the video', async () => {
    const duration = 100.500123
    const initial = await request('POST', `/lessons/${second.id}/progress`, { ...checkpoint([[0, 5]], 0, 5), duration_seconds: duration })
    expect(initial.statusCode).toBe(200)
    expect(initial.json().duration_seconds).toBe(duration)
    const ended = await request('POST', `/lessons/${second.id}/progress`, {
      ...checkpoint([[5, duration]], initial.json().position_revision, duration), duration_seconds: duration,
    })
    expect(ended.statusCode).toBe(200)
    expect(ended.json().state).toBe('completed')
    expect(ended.json().last_position_seconds).toBe(duration)
  })

  it('preserves measured history when a video is replaced and preserves legacy completion without fabricating a percent', async () => {
    const replaced = await request('PATCH', `/admin/lessons/${first.id}`, { video_provider: 'youtube', video_input: 'dQw4w9WgXcQ' })
    expect(replaced.statusCode).toBe(200)
    const current = (await request('GET', `/lessons/${first.id}`, undefined, 'apresentadora', A, LEARNER)).json()
    expect(current.video_version).toBe(2)
    expect(current.progress.state).toBe('not_started')
    expect((await request('POST', `/lessons/${first.id}/progress`, checkpoint([[0, 1]]), 'apresentadora', A, LEARNER)).statusCode).toBe(409)
    expect((await db.query('SELECT completed_at FROM training_video_progress WHERE lesson_id=$1 AND video_version=1', [first.id])).rows[0].completed_at).toBeTruthy()
    await db.query('INSERT INTO training_lesson_progress(tenant_id,user_id,lesson_id,completed_at) VALUES($1,$2,$3,NOW())', [A, IDLE, second.id])
    const legacy = await request('POST', `/lessons/${second.id}/progress`, checkpoint([[0, 1]]), 'operacional', A, IDLE)
    expect(legacy.json().state).toBe('completed')
    expect(legacy.json().watched_percent).toBeNull()
    expect(legacy.json().completion_source).toBe('legacy')
    const moved = await request('POST', '/admin/trails', { title: 'Destino' })
    expect((await request('PATCH', `/admin/lessons/${second.id}`, { trail_id: moved.json().id })).statusCode).toBe(200)
    expect((await request('GET', `/trails/${moved.json().slug}`)).json().lesson_count).toBe(1)
  })

  it('enforces new-table RLS for reads and writes across tenants', async () => {
    await db.exec('CREATE ROLE training_video_probe; GRANT USAGE ON SCHEMA public TO training_video_probe; GRANT SELECT,INSERT,UPDATE ON training_video_progress TO training_video_probe; SET ROLE training_video_probe;')
    try {
      await db.query("SELECT set_config('app.tenant_id',$1,false)", [B])
      expect((await db.query('SELECT lesson_id FROM training_video_progress')).rows).toEqual([])
      await expect(db.query('INSERT INTO training_video_progress(tenant_id,user_id,lesson_id,video_version) VALUES($1,$2,$3,1)', [A, IDLE, first.id])).rejects.toThrow(/row.level security/i)
    } finally { await db.exec('RESET ROLE') }
  })

  it('uses a replacement video when an existing linked material is explicitly edited into a video lesson', async () => {
    const seededLesson = 'a1111111-1111-4111-8111-111111111131'
    const changed = await request('PATCH', `/admin/lessons/${seededLesson}`, {
      video_provider: 'youtube', video_input: 'M7lc1UVf-VE', video_library_id: null,
    })
    expect(changed.statusCode).toBe(200)
    const detail = (await request('GET', `/lessons/${seededLesson}`)).json()
    expect(detail.video_provider).toBe('youtube')
    expect(detail.video_id).toBe('M7lc1UVf-VE')
    expect(detail.content_available).toBe(true)
    expect(detail.video_version).toBe(2)
  })

  it('tracks an existing unit video linked by title and blocks manual video completion', async () => {
    const seededLesson = 'a1111111-1111-4111-8111-111111111132'
    await db.query("INSERT INTO knowledge_materials(tenant_id,title,status,video_provider,video_id) VALUES($1,'Oferta, estoque e cupom no TikTok Shop','published','youtube','M7lc1UVf-VE')", [A])
    expect((await request('POST', `/lessons/${seededLesson}/complete`)).statusCode).toBe(409)
    const saved = await request('POST', `/lessons/${seededLesson}/progress`, checkpoint([[0, 10]], 0, 10))
    expect(saved.statusCode).toBe(200)
    expect(saved.json().state).toBe('in_progress')
    expect(saved.json().watched_percent).toBeCloseTo(10 / 100.5 * 100, 1)
  })

  it('does not allow manual completion when a direct video source cannot be resolved', async () => {
    const created = await request('POST', `/admin/trails/${trail.id}/lessons`, {
      title: 'Fonte indisponível', video_provider: 'youtube', video_input: 'M7lc1UVf-VE',
    })
    expect(created.statusCode).toBe(201)
    const lessonId = created.json().id
    await db.query('UPDATE training_lessons SET video_url=$1 WHERE id=$2', ['https://invalid.example/video', lessonId])
    expect((await request('POST', `/lessons/${lessonId}/complete`)).statusCode).toBe(409)
    expect((await db.query('SELECT lesson_id FROM training_lesson_progress WHERE lesson_id=$1', [lessonId])).rows).toEqual([])
  })

  it('deletes training records locally without calling a video-provider deletion endpoint', async () => {
    const deleted = await request('DELETE', `/admin/trails/${trail.id}`)
    expect(deleted.statusCode).toBe(204)
    expect((await db.query('SELECT id FROM training_lessons WHERE id=$1', [first.id])).rows).toEqual([])
    expect((await db.query('SELECT lesson_id FROM training_video_progress WHERE lesson_id=$1', [first.id])).rows).toEqual([])
  })
})
