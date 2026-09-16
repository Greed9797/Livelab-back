import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const USER_A = '33333333-3333-4333-8333-333333333333'

async function createDb() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE base_reader;
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    INSERT INTO tenants VALUES ('${TENANT_A}'), ('${TENANT_B}');
    INSERT INTO users VALUES ('${USER_A}');
  `)
  await db.exec(fs.readFileSync(new URL('../migrations/153_knowledge_unit_library.sql', import.meta.url), 'utf8'))
  await db.exec(`GRANT USAGE ON SCHEMA public TO base_reader; GRANT SELECT ON knowledge_unit_categories, knowledge_materials, knowledge_material_attachments TO base_reader;`)
  return db
}

describe('knowledge unit migration against PostgreSQL-compatible SQL', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('keeps categories and materials tenant scoped through RLS and composite foreign keys', async () => {
    db = await createDb()
    const category = await db.query(`INSERT INTO knowledge_unit_categories (tenant_id, name, slug) VALUES ($1, 'Operação', 'operacao') RETURNING id`, [TENANT_A])
    const categoryId = category.rows[0].id

    await expect(db.query(`INSERT INTO knowledge_materials (tenant_id, category_id, title, slug, content_markdown, created_by, updated_by) VALUES ($1, $2, 'Playbook', 'playbook', 'texto', $3, $3)`, [TENANT_B, categoryId, USER_A])).rejects.toMatchObject({ code: '23503' })

    await db.exec('ALTER TABLE knowledge_unit_categories FORCE ROW LEVEL SECURITY')
    await db.exec('SET ROLE base_reader')
    await db.exec(`SET app.tenant_id = '${TENANT_B}'`)
    const isolated = await db.query('SELECT id FROM knowledge_unit_categories')
    expect(isolated.rows).toEqual([])
  })

  it('enforces the PDF metadata limits in the database', async () => {
    db = await createDb()
    const material = await db.query(`INSERT INTO knowledge_materials (tenant_id, title, slug, content_markdown, created_by, updated_by) VALUES ($1, 'Playbook', 'playbook', 'texto', $2, $2) RETURNING id`, [TENANT_A, USER_A])
    await expect(db.query(`INSERT INTO knowledge_material_attachments (tenant_id, material_id, storage_key, original_name, mime_type, byte_size) VALUES ($1, $2, 'opaque/key', 'x.pdf', 'text/plain', 10)`, [TENANT_A, material.rows[0].id])).rejects.toMatchObject({ code: '23514' })
  })
})
