// Disposable real-SQL proof for migration 147 and the manager-delete helper.
// Run with PGLITE_MODULE pointing to a local PGlite package. Never uses production.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tombstoneApprovedSubmissionsForDeletedLive } from '../src/services/live-approved-submission-deletion.js'

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), manager = id(2), live = id(3), presenterA = id(4), presenterB = id(5)

await db.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  CREATE TABLE users (id uuid PRIMARY KEY);
  CREATE TABLE apresentadoras (id uuid PRIMARY KEY);
  CREATE TABLE marcas (id uuid PRIMARY KEY);
  CREATE TABLE cabines (id uuid PRIMARY KEY);
  CREATE TABLE lives (id uuid PRIMARY KEY);
`)
await db.exec(await readFile(new URL('../migrations/144_portal_apresentadora_submissoes.sql', import.meta.url), 'utf8'))
await db.exec(await readFile(new URL('../migrations/147_live_oficial_excluida_tombstone.sql', import.meta.url), 'utf8'))
await db.query('INSERT INTO tenants VALUES ($1)', [tenant])
await db.query('INSERT INTO users VALUES ($1)', [manager])
await db.query('INSERT INTO apresentadoras VALUES ($1),($2)', [presenterA, presenterB])
await db.query('INSERT INTO lives VALUES ($1)', [live])
for (const [n, presenter] of [[10, presenterA], [11, presenterB]]) {
  await db.query(
    `INSERT INTO apresentadora_live_submissoes
      (id,tenant_id,apresentadora_id,marca_descricao,iniciado_em,encerrado_em,status,live_oficial_id,revisado_por,revisado_em)
     VALUES ($1,$2,$3,'Histórica','2026-09-01T12:00Z','2026-09-01T13:00Z','aprovada',$4,$5,NOW())`,
    [id(n), tenant, presenter, live, manager],
  )
}

// The approved state is unambiguous: a live is either physically linked or
// tombstoned, never both and never a partial tombstone.
await assert.rejects(
  db.query('UPDATE apresentadora_live_submissoes SET live_oficial_excluida_id=$1 WHERE id=$2', [live, id(10)]),
  (error) => error.code === '23514',
)

await db.query('BEGIN')
const changed = await tombstoneApprovedSubmissionsForDeletedLive(db, { tenantId: tenant, liveId: live, actorId: manager })
assert.equal(changed.length, 2)
await db.query('DELETE FROM lives WHERE id=$1', [live])
await db.query('COMMIT')

const rows = await db.query(`SELECT status,live_oficial_id,live_oficial_excluida_id,live_oficial_excluida_em IS NOT NULL AS deleted_at,versao
  FROM apresentadora_live_submissoes WHERE tenant_id=$1 ORDER BY id`, [tenant])
assert.equal(rows.rows.length, 2)
for (const row of rows.rows) {
  assert.equal(row.status, 'aprovada')
  assert.equal(row.live_oficial_id, null)
  assert.equal(row.live_oficial_excluida_id, live)
  assert.equal(row.deleted_at, true)
  assert.equal(row.versao, 2)
}
await assert.rejects(
  db.query('UPDATE apresentadora_live_submissoes SET live_oficial_excluida_em=NULL WHERE id=$1', [id(10)]),
  (error) => error.code === '23514',
)
const history = await db.query(`SELECT acao, snapshot->>'live_oficial_excluida_id' AS tombstone FROM apresentadora_live_submissao_historico ORDER BY submissao_id`)
assert.equal(history.rows.length, 2)
for (const row of history.rows) {
  assert.equal(row.acao, 'live_oficial_excluida')
  assert.equal(row.tombstone, live)
}

// A later retry cannot reattach a deleted live through this helper; it has no
// physical FK to change once the tombstone is set.
await db.query('BEGIN')
assert.equal((await tombstoneApprovedSubmissionsForDeletedLive(db, { tenantId: tenant, liveId: live, actorId: manager })).length, 0)
await db.query('ROLLBACK')

// A real audit insert failure (invalid actor FK) rolls the tombstone and leaves
// both the physical live and the approved FK untouched.
const rollbackLive = id(20), rollbackSubmission = id(21)
await db.query('INSERT INTO lives VALUES ($1)', [rollbackLive])
await db.query(
  `INSERT INTO apresentadora_live_submissoes
    (id,tenant_id,apresentadora_id,marca_descricao,iniciado_em,encerrado_em,status,live_oficial_id,revisado_por,revisado_em)
   VALUES ($1,$2,$3,'Rollback','2026-09-02T12:00Z','2026-09-02T13:00Z','aprovada',$4,$5,NOW())`,
  [rollbackSubmission, tenant, presenterA, rollbackLive, manager],
)
await db.query('BEGIN')
await assert.rejects(
  tombstoneApprovedSubmissionsForDeletedLive(db, { tenantId: tenant, liveId: rollbackLive, actorId: id(99) }),
  (error) => error.code === '23503',
)
await db.query('ROLLBACK')
const rolledBack = await db.query('SELECT live_oficial_id,live_oficial_excluida_id FROM apresentadora_live_submissoes WHERE id=$1', [rollbackSubmission])
assert.deepEqual(rolledBack.rows[0], { live_oficial_id: rollbackLive, live_oficial_excluida_id: null })
assert.equal((await db.query('SELECT count(*)::int AS n FROM lives WHERE id=$1', [rollbackLive])).rows[0].n, 1)

console.log(JSON.stringify({ submissions: rows.rows.length, history: history.rows.length, status: 'aprovada', tombstone: live }))
await db.close()
