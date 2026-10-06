import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { consultarFechamento, mudarFechamento } from '../src/services/financeiro-fechamentos.js'

const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1)
const outro = id(2)
const ator = id(3)
await db.exec(`CREATE TABLE tenants (id uuid PRIMARY KEY);
  INSERT INTO tenants VALUES ('${tenant}'), ('${outro}');
  CREATE TABLE audit_log (id uuid DEFAULT gen_random_uuid(), tenant_id uuid, user_id uuid,
    action text NOT NULL, entity_type text, entity_id uuid, metadata jsonb);`)
const migration = await readFile(new URL('../migrations/182_financeiro_fechamentos.sql', import.meta.url), 'utf8')
await db.exec(migration)
await db.exec(migration)

await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant])
let calcCount = 0
const calcular = async () => ({ mes: '2026-09', atual: { resultado: { previsto: 100 + ++calcCount, realizado: 40 } } })
const args = { tenantId: tenant, mes: '2026-09', actorUserId: ator, calcular }

assert.equal((await consultarFechamento(db, args)).estado, 'aberto')
const first = await mudarFechamento(db, { ...args, evento: 'fechamento' })
assert.equal(first.estado, 'fechado')
assert.equal(first.versao_atual, 1)
assert.equal(first.versoes[0].snapshot.atual.resultado.previsto, 101)
await assert.rejects(mudarFechamento(db, { ...args, evento: 'fechamento' }), { statusCode: 409 })
assert.equal(calcCount, 1)

const reopened = await mudarFechamento(db, { ...args, evento: 'reabertura', motivo: 'Ajuste documentado' })
assert.equal(reopened.estado, 'reaberto')
assert.equal(reopened.versao_atual, 1)
await assert.rejects(mudarFechamento(db, { ...args, evento: 'reabertura', motivo: 'duplicado' }), { statusCode: 409 })
const second = await mudarFechamento(db, { ...args, evento: 'fechamento' })
assert.equal(second.versao_atual, 2)
assert.deepEqual(second.versoes.map((v) => v.snapshot.atual.resultado.previsto), [101, 102])
assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, 3)
await assert.rejects(db.query('DELETE FROM financeiro_fechamentos'), /imutável/)

await db.exec(`CREATE ROLE financeiro_rls_test;
  GRANT USAGE ON SCHEMA public TO financeiro_rls_test;
  GRANT SELECT ON financeiro_fechamentos TO financeiro_rls_test;`)
await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [outro])
await db.exec('SET ROLE financeiro_rls_test')
const seen = await db.query(`SELECT count(*)::int AS n FROM financeiro_fechamentos WHERE tenant_id = $1`, [tenant])
assert.equal(seen.rows[0].n, 0)
await db.exec('RESET ROLE')
const catalog = await db.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'financeiro_fechamentos'`)
assert.deepEqual(catalog.rows[0], { relrowsecurity: true, relforcerowsecurity: true })
await db.close()
console.log('financeiro fechamentos PGlite: OK')
