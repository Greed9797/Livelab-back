// FIN-02: prova SQL real e isolada do schema aditivo de perdas/reversões.
import assert from 'node:assert/strict'

import { PGlite } from '@electric-sql/pglite'
import { applyMigration } from '../apply_migrations.js'

const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenantA = id(1)
const tenantB = id(2)
const tituloLegado = id(10)
const avulsaLegada = id(11)

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
  CREATE TABLE receita_titulos (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    competencia date NOT NULL,
    valor_previsto numeric(15,2) NOT NULL,
    perdido_em timestamptz,
    perdido_motivo text
  );
  CREATE TABLE receitas_avulsas (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    competencia date NOT NULL,
    valor_previsto numeric(15,2) NOT NULL,
    perdido_em timestamptz,
    perdido_motivo text
  );

  INSERT INTO tenants(id) VALUES ('${tenantA}'), ('${tenantB}');
  INSERT INTO receita_titulos (
    id, tenant_id, competencia, valor_previsto, perdido_em, perdido_motivo
  ) VALUES (
    '${tituloLegado}', '${tenantA}', '2026-09-01', 100.00,
    '2026-10-02T12:00:00Z', 'legado preservado'
  );
  INSERT INTO receitas_avulsas (
    id, tenant_id, competencia, valor_previsto
  ) VALUES ('${avulsaLegada}', '${tenantA}', '2026-09-01', 80.00);
`)

await applyMigration(client, '181_financeiro_perdas_reversoes.sql')
await applyMigration(client, '181_financeiro_perdas_reversoes.sql')

const migrationRows = await db.query(`
  SELECT count(*)::int AS total
    FROM schema_migrations
   WHERE version = '181_financeiro_perdas_reversoes.sql'
`)
assert.equal(migrationRows.rows[0].total, 1)

const columns = await db.query(`
  SELECT table_name, data_type, numeric_precision, numeric_scale, is_nullable
    FROM information_schema.columns
   WHERE table_name IN ('receita_titulos', 'receitas_avulsas')
     AND column_name = 'valor_perdido'
   ORDER BY table_name
`)
assert.deepEqual(columns.rows, [
  {
    table_name: 'receita_titulos',
    data_type: 'numeric',
    numeric_precision: 15,
    numeric_scale: 2,
    is_nullable: 'YES',
  },
  {
    table_name: 'receitas_avulsas',
    data_type: 'numeric',
    numeric_precision: 15,
    numeric_scale: 2,
    is_nullable: 'YES',
  },
])

const legadoTitulo = await db.query(`
  SELECT valor_perdido, perdido_motivo
    FROM receita_titulos
   WHERE id = $1
`, [tituloLegado])
assert.deepEqual(legadoTitulo.rows[0], {
  valor_perdido: null,
  perdido_motivo: 'legado preservado',
})

const legadoAvulsa = await db.query(`
  SELECT valor_perdido
    FROM receitas_avulsas
   WHERE id = $1
`, [avulsaLegada])
assert.equal(legadoAvulsa.rows[0].valor_perdido, null)

await db.query('UPDATE receita_titulos SET valor_perdido = 25.50 WHERE id = $1', [tituloLegado])
assert.equal(
  (await db.query('SELECT valor_perdido FROM receita_titulos WHERE id = $1', [tituloLegado])).rows[0].valor_perdido,
  '25.50',
)
await assert.rejects(
  db.query('UPDATE receitas_avulsas SET valor_perdido = -0.01 WHERE id = $1', [avulsaLegada]),
  (error) => error.code === '23514',
)

const rls = await db.query(`
  SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
   WHERE relname = 'financeiro_perdas_eventos'
`)
assert.deepEqual(rls.rows, [
  { relname: 'financeiro_perdas_eventos', relrowsecurity: true, relforcerowsecurity: true },
])

async function inserirEvento({
  tenantId = tenantA,
  tipo = 'perda',
  origemTipo = 'receita_titulo',
  origemId = tituloLegado,
  valor = '25.50',
  motivo = 'inadimplência confirmada',
  competencia = '2026-09-01',
  registradoEm = '2026-10-05T15:00:00Z',
  perdaOriginalId = null,
}) {
  const { rows } = await db.query(`
    INSERT INTO financeiro_perdas_eventos (
      tenant_id, tipo, origem_tipo, origem_id, valor, motivo,
      ator_tipo, ator_id, competencia_obrigacao, registrado_em,
      perda_original_id, perda_original_tipo
    ) VALUES (
      $1::uuid, $2, $3, $4::uuid, $5::numeric, $6,
      'usuario', 'usuario-teste', $7::date, $8::timestamptz,
      $9::uuid, CASE WHEN $2 = 'reversao' THEN 'perda' ELSE NULL END
    )
    RETURNING id
  `, [
    tenantId, tipo, origemTipo, origemId, valor, motivo,
    competencia, registradoEm, perdaOriginalId,
  ])
  return rows[0].id
}

const perdaTitulo = await inserirEvento({})
const perdaAvulsa = await inserirEvento({
  origemTipo: 'receita_avulsa',
  origemId: avulsaLegada,
  valor: '10.00',
  motivo: 'perda avulsa',
})
assert.ok(perdaAvulsa)

const reversao = await inserirEvento({
  tipo: 'reversao',
  valor: '5.50',
  motivo: 'reversão autorizada',
  registradoEm: '2026-11-03T10:00:00Z',
  perdaOriginalId: perdaTitulo,
})
assert.ok(reversao)

const datas = await db.query(`
  SELECT tipo, competencia_obrigacao::text, registrado_em::date::text AS data_registro
    FROM financeiro_perdas_eventos
   WHERE id IN ($1, $2)
   ORDER BY registrado_em
`, [perdaTitulo, reversao])
assert.deepEqual(datas.rows, [
  { tipo: 'perda', competencia_obrigacao: '2026-09-01', data_registro: '2026-10-05' },
  { tipo: 'reversao', competencia_obrigacao: '2026-09-01', data_registro: '2026-11-03' },
])

await assert.rejects(
  inserirEvento({ valor: '0.00', motivo: 'zero' }),
  (error) => error.code === '23514',
)
await assert.rejects(
  inserirEvento({ motivo: '   ' }),
  (error) => error.code === '23514',
)
await assert.rejects(
  inserirEvento({
    tenantId: tenantB,
    tipo: 'reversao',
    perdaOriginalId: perdaTitulo,
    motivo: 'tenant errado',
  }),
  (error) => error.code === '23503',
)
await assert.rejects(
  inserirEvento({
    tipo: 'reversao',
    origemTipo: 'receita_avulsa',
    origemId: avulsaLegada,
    perdaOriginalId: perdaTitulo,
    motivo: 'origem divergente',
  }),
  (error) => error.code === '23503',
)

await assert.rejects(
  db.query("UPDATE financeiro_perdas_eventos SET motivo = 'mutação' WHERE id = $1", [perdaTitulo]),
  (error) => error.code === '55000',
)
await assert.rejects(
  db.query('DELETE FROM financeiro_perdas_eventos WHERE id = $1', [reversao]),
  (error) => error.code === '55000',
)

await inserirEvento({
  tenantId: tenantB,
  origemId: id(20),
  valor: '30.00',
  motivo: 'perda tenant B',
})

await db.exec(`
  CREATE ROLE fin02_reader;
  GRANT USAGE ON SCHEMA public TO fin02_reader;
  GRANT SELECT, INSERT ON financeiro_perdas_eventos TO fin02_reader;
`)
await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantA])
await db.exec('SET ROLE fin02_reader')
try {
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_perdas_eventos')).rows[0].total,
    3,
  )

  await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantB])
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_perdas_eventos')).rows[0].total,
    1,
  )

  await db.exec('RESET app.tenant_id')
  assert.equal(
    (await db.query('SELECT count(*)::int AS total FROM financeiro_perdas_eventos')).rows[0].total,
    0,
  )

  await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantA])
  await assert.rejects(
    inserirEvento({ tenantId: tenantB, origemId: id(21), motivo: 'bloqueado por RLS' }),
    (error) => error.code === '42501',
  )
} finally {
  await db.exec('RESET ROLE')
}

console.log('PASS: FIN-02 schema aditivo, perdas/reversões imutáveis, projeção parcial e RLS por tenant')
await db.close()
