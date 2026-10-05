// FIN-03A: prova SQL real e isolada para liquidações/estornos. Nunca usa produção.
import assert from 'node:assert/strict'

import { PGlite } from '@electric-sql/pglite'
import { applyMigration } from '../apply_migrations.js'

const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// Adapter mínimo para exercitar o mesmo applyMigration usado pelo boot runner.
const client = {
  async query(sql, params) {
    if (params?.length) return db.query(sql, params)
    await db.exec(sql)
    return { rows: [] }
  },
}

await db.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  CREATE TABLE schema_migrations (
    version varchar(255) PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO tenants(id) VALUES ('${id(1)}'), ('${id(2)}');
`)

await applyMigration(client, '180_financeiro_liquidacoes_estornos.sql')
await applyMigration(client, '180_financeiro_liquidacoes_estornos.sql')

const migrationRows = await db.query(
  `SELECT count(*)::int AS total FROM schema_migrations
    WHERE version = '180_financeiro_liquidacoes_estornos.sql'`,
)
assert.equal(migrationRows.rows[0].total, 1)

const rls = await db.query(`
  SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
   WHERE relname IN ('financeiro_liquidacoes', 'financeiro_estornos')
   ORDER BY relname
`)
assert.deepEqual(rls.rows, [
  { relname: 'financeiro_estornos', relrowsecurity: true, relforcerowsecurity: true },
  { relname: 'financeiro_liquidacoes', relrowsecurity: true, relforcerowsecurity: true },
])

const insertLiquidacao = async ({ tenant = id(1), key, origem = id(10), valor = '125.50' }) => {
  const result = await db.query(`
    INSERT INTO financeiro_liquidacoes (
      tenant_id, natureza, origem_tipo, origem_id, valor, data_liquidacao,
      comando_origem, ator_tipo, ator_id, motivo,
      idempotencia_chave, idempotencia_payload
    ) VALUES ($1, 'receita', 'receita_titulo', $2, $3, '2026-10-05',
              'teste', 'sistema', 'pglite', NULL, $4, $5::jsonb)
    RETURNING id
  `, [tenant, origem, valor, key, JSON.stringify({ origem, valor, data: '2026-10-05' })])
  return result.rows[0].id
}

const liquidacao1 = await insertLiquidacao({ key: 'liq-1' })
await insertLiquidacao({ tenant: id(2), key: 'liq-1', origem: id(20) })

await assert.rejects(
  insertLiquidacao({ key: 'liq-1', valor: '130.00' }),
  (error) => error.code === '23505',
)
await assert.rejects(
  insertLiquidacao({ key: 'liq-zero', valor: '0.00' }),
  (error) => error.code === '23514',
)

const payload = await db.query(
  `SELECT idempotencia_payload FROM financeiro_liquidacoes WHERE id = $1`,
  [liquidacao1],
)
assert.deepEqual(payload.rows[0].idempotencia_payload, {
  origem: id(10), valor: '125.50', data: '2026-10-05',
})

const estorno1 = await db.query(`
  INSERT INTO financeiro_estornos (
    tenant_id, liquidacao_id, valor, data_estorno, comando_origem,
    ator_tipo, ator_id, motivo, idempotencia_chave, idempotencia_payload
  ) VALUES ($1, $2, 25.50, '2026-10-06', 'teste',
            'sistema', 'pglite', 'ajuste de teste', 'est-1',
            '{"liquidacao":"liq-1","valor":"25.50"}'::jsonb)
  RETURNING id
`, [id(1), liquidacao1])
assert.ok(estorno1.rows[0].id)

await assert.rejects(
  db.query(`
    INSERT INTO financeiro_estornos (
      tenant_id, liquidacao_id, valor, data_estorno, comando_origem,
      ator_tipo, ator_id, idempotencia_chave, idempotencia_payload
    ) VALUES ($1, $2, 1, '2026-10-06', 'teste', 'sistema', 'pglite',
              'est-cross-tenant', '{}'::jsonb)
  `, [id(2), liquidacao1]),
  (error) => error.code === '23503',
)

await assert.rejects(
  db.query(`UPDATE financeiro_liquidacoes SET motivo = 'mutação' WHERE id = $1`, [liquidacao1]),
  (error) => error.code === '55000',
)
await assert.rejects(
  db.query(`DELETE FROM financeiro_estornos WHERE id = $1`, [estorno1.rows[0].id]),
  (error) => error.code === '55000',
)

await db.exec(`
  CREATE ROLE fin03_reader;
  GRANT USAGE ON SCHEMA public TO fin03_reader;
  GRANT SELECT, INSERT ON financeiro_liquidacoes, financeiro_estornos TO fin03_reader;
`)
await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [id(1)])
await db.exec('SET ROLE fin03_reader')
try {
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_liquidacoes')).rows[0].total,
    1,
  )
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_estornos')).rows[0].total,
    1,
  )

  await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [id(2)])
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_liquidacoes')).rows[0].total,
    1,
  )
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_estornos')).rows[0].total,
    0,
  )

  await db.exec('RESET app.tenant_id')
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_liquidacoes')).rows[0].total,
    0,
  )
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_estornos')).rows[0].total,
    0,
  )

  await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [id(1)])
  assert.ok(await insertLiquidacao({ key: 'rls-own-tenant' }))
  await assert.rejects(
    insertLiquidacao({ tenant: id(2), key: 'rls-other-tenant' }),
    (error) => error.code === '42501',
  )
} finally {
  await db.exec('RESET ROLE')
}

console.log('PASS: FIN-03A migration rerunnable via runner, constraints, immutability and tenant RLS')
await db.close()
