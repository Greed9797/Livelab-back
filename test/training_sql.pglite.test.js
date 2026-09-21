import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const USER_A = '33333333-3333-4333-8333-333333333333'
const LESSON = 'a1111111-1111-4111-8111-111111111131'

async function createDb() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE training_reader;
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE manuais (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      titulo text NOT NULL,
      url text NOT NULL DEFAULT '',
      atualizado_em timestamptz NOT NULL DEFAULT NOW()
    );
    INSERT INTO tenants VALUES ('${TENANT_A}'), ('${TENANT_B}');
    INSERT INTO users VALUES ('${USER_A}');
  `)
  await db.exec(fs.readFileSync(new URL('../migrations/157_training_p0.sql', import.meta.url), 'utf8'))
  await db.exec('GRANT USAGE ON SCHEMA public TO training_reader; GRANT SELECT, INSERT ON training_lesson_progress, training_bookmarks TO training_reader; GRANT SELECT ON training_trails, training_modules, training_lessons, training_updates TO training_reader;')
  return db
}

describe('training P0 migration', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('seeds the starter trail and isolates progress by tenant', async () => {
    db = await createDb()
    const trail = await db.query("SELECT slug, title FROM training_trails WHERE slug = 'primeira-live-que-converte'")
    expect(trail.rows[0].title).toBe('Primeira Live que converte')
    const lessons = await db.query('SELECT title, required, source_kind FROM training_lessons ORDER BY sort_order')
    expect(lessons.rows.length).toBe(5)
    expect(lessons.rows.every((row) => row.required)).toBe(true)

    await db.exec(`SET app.tenant_id = '${TENANT_A}'`)
    await db.query(
      'INSERT INTO training_lesson_progress (tenant_id, user_id, lesson_id) VALUES ($1, $2, $3)',
      [TENANT_A, USER_A, LESSON],
    )
    await db.exec('SET ROLE training_reader')
    await db.exec(`SET app.tenant_id = '${TENANT_B}'`)
    const isolated = await db.query('SELECT lesson_id FROM training_lesson_progress')
    expect(isolated.rows).toEqual([])
  })

  it('orders complete/next by module then lesson, not lesson.sort_order alone', async () => {
    db = await createDb()
    const ordered = await db.query(`
      SELECT l.id::text AS id
        FROM training_lessons AS current_lesson
        JOIN training_modules AS current_module ON current_module.id = current_lesson.module_id
        JOIN training_trails AS trail ON trail.id = current_module.trail_id
        JOIN training_modules AS module ON module.trail_id = trail.id
        JOIN training_lessons AS l ON l.module_id = module.id
       WHERE current_lesson.id = $1
       ORDER BY module.sort_order, l.sort_order
    `, [LESSON])
    expect(ordered.rows.map((row) => row.id)).toEqual([
      'a1111111-1111-4111-8111-111111111131',
      'a1111111-1111-4111-8111-111111111132',
      'a1111111-1111-4111-8111-111111111133',
      'a1111111-1111-4111-8111-111111111134',
      'a1111111-1111-4111-8111-111111111135',
    ])
  })

  it('refuses a certificate-like extra table and keeps progress explicit', async () => {
    db = await createDb()
    const tables = await db.query(`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename LIKE 'training_%'
       ORDER BY tablename
    `)
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'training_bookmarks',
      'training_lesson_progress',
      'training_lessons',
      'training_modules',
      'training_trails',
      'training_updates',
    ])
  })

  it('stops requiring the empty starter lesson and leaves the others required', async () => {
    db = await createDb()
    const sql = fs.readFileSync(new URL('../migrations/158_training_empty_lesson.sql', import.meta.url), 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    const lessons = await db.query(`
      SELECT title, required, source_kind
        FROM training_lessons
       ORDER BY title
    `)
    const demo = lessons.rows.find((row) => row.title === 'Demonstração, prova e CTA')
    expect(demo.required).toBe(false)
    expect(demo.source_kind).toBe('none')
    expect(lessons.rows.filter((row) => row.title !== 'Demonstração, prova e CTA').every((row) => row.required)).toBe(true)
  })

  it('leaves the empty starter lesson required once it has a source', async () => {
    db = await createDb()
    await db.query(`
      UPDATE training_lessons
         SET source_kind = 'network_article', source_slug = 'roteiro-cta'
       WHERE title = 'Demonstração, prova e CTA'
    `)
    const sql = fs.readFileSync(new URL('../migrations/158_training_empty_lesson.sql', import.meta.url), 'utf8')
    await db.exec(sql)
    const demo = await db.query(`
      SELECT required FROM training_lessons WHERE title = 'Demonstração, prova e CTA'
    `)
    expect(demo.rows[0].required).toBe(true)
  })
})
