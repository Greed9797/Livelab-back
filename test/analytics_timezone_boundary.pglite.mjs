import assert from 'node:assert/strict'
// Verificação SQL opcional: use PGLITE_MODULE para uma instalação local isolada.
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')

import { analyticsLiveRangeSql } from '../src/routes/analytics.js'

const db = new PGlite()

await db.exec(`
  SET TIME ZONE 'UTC';
  CREATE TABLE lives (
    id text PRIMARY KEY,
    iniciado_em timestamptz NOT NULL
  );
  INSERT INTO lives (id, iniciado_em) VALUES
    ('before-start', TIMESTAMPTZ '2026-09-01 02:59:59+00'),
    ('at-start', TIMESTAMPTZ '2026-09-01 03:00:00+00'),
    ('before-end', TIMESTAMPTZ '2026-10-01 02:59:59+00'),
    ('at-end', TIMESTAMPTZ '2026-10-01 03:00:00+00');
`)

const { rows } = await db.query(`
  SELECT id,
         (iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia_local
    FROM lives l
   WHERE TRUE
     ${analyticsLiveRangeSql('l')}
   ORDER BY iniciado_em
`, ['2026-09-01', '2026-09-30'])

assert.deepEqual(rows, [
  { id: 'at-start', dia_local: '2026-09-01' },
  { id: 'before-end', dia_local: '2026-09-30' },
])

const { rows: dayRows } = await db.query(`
  SELECT sample.id
    FROM (VALUES
      ('before-day', TIMESTAMPTZ '2026-09-05 02:59:59+00'),
      ('at-day-start', TIMESTAMPTZ '2026-09-05 03:00:00+00'),
      ('at-day-end', TIMESTAMPTZ '2026-09-06 02:59:59+00'),
      ('after-day', TIMESTAMPTZ '2026-09-06 03:00:00+00')
    ) AS sample(id, iniciado_em)
   WHERE TRUE
     ${analyticsLiveRangeSql('sample')}
   ORDER BY sample.iniciado_em
`, ['2026-09-05', '2026-09-05'])
assert.deepEqual(dayRows, [{ id: 'at-day-start' }, { id: 'at-day-end' }])

const { rows: types } = await db.query(`
  SELECT pg_typeof(($1::timestamp) AT TIME ZONE 'America/Sao_Paulo')::text AS boundary_type
`, ['2026-09-01'])
assert.equal(types[0].boundary_type, 'timestamp with time zone')

console.log(JSON.stringify({
  verified: true,
  sessionTimeZone: 'UTC',
  range: ['2026-09-01', '2026-09-30'],
  included: rows,
  excluded: ['before-start', 'at-end'],
  singleDayIncluded: dayRows,
}))

await db.close()
