import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { MIGRATIONS_LIST, applyMigration } from '../apply_migrations.js'

describe('applyMigration', () => {
  it('runs concurrent index migrations outside a transaction', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await applyMigration(client, '026_add_analytics_dashboard_indexes.sql')

    const queries = client.query.mock.calls.map(([sql]) => sql)
    expect(queries[0]).toContain('CREATE INDEX CONCURRENTLY')
    expect(queries).not.toContain('BEGIN')
    expect(queries).not.toContain('COMMIT')
    expect(queries[1]).toContain('INSERT INTO schema_migrations')
  })

  it('splits multi-statement concurrent migrations so PostgreSQL does not wrap them in one transaction block', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await applyMigration(client, '084_performance_indexes.sql')

    const queries = client.query.mock.calls.map(([sql]) => sql)
    const indexQueries = queries.filter((sql) => /CREATE INDEX CONCURRENTLY/i.test(sql))
    expect(indexQueries).toHaveLength(8)
    expect(queries).not.toContain('BEGIN')
    expect(queries).not.toContain('COMMIT')
    expect(queries.at(-1)).toContain('INSERT INTO schema_migrations')
  })

  it('keeps regular migrations transactional', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await applyMigration(client, '016_auditoria_implantacao.sql')

    const queries = client.query.mock.calls.map(([sql]) => sql)
    expect(queries[0]).toBe('BEGIN')
    expect(queries.at(-1)).toBe('COMMIT')
  })

  it('includes every migration file from 016 onward in the boot runner', () => {
    const migrationDir = path.join(process.cwd(), 'migrations')
    const filesFrom016 = fs.readdirSync(migrationDir)
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .filter((file) => Number(file.slice(0, 3)) >= 16)
      .sort()

    expect(MIGRATIONS_LIST).toEqual(filesFrom016)
  })
})
