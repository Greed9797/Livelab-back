import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

import {
  officialEndedLiveSql,
  presenterFanoutSql,
  presenterGmvShareSql,
  saoPauloInclusiveRangeSql,
} from '../src/lib/live-count-sql.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const EDJA_USER = '443c88f2-584f-4456-82fa-30a8af08fa90'
const DEFINIR_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ANA_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EDJA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DEFINIR = '2ff764d7-aadc-47e6-94ec-a844e4ffcdec'
const ANA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const BIA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const FROM = '2026-09-01'
const TO = '2026-09-30'

function brandSql() {
  return `
    SELECT COUNT(DISTINCT l.id)::int AS lives,
           COALESCE(SUM(CASE WHEN l.ads_gmv IS NULL AND l.manual_gmv IS NULL AND l.fat_gerado IS NULL THEN NULL ELSE COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado) END), 0) AS gmv_presente,
           COUNT(DISTINCT l.id) FILTER (WHERE l.ads_gmv IS NOT NULL OR l.manual_gmv IS NOT NULL OR l.fat_gerado IS NOT NULL)::int AS lives_com_valor
      FROM lives l
     WHERE l.tenant_id = $1::uuid
       AND ${officialEndedLiveSql('l')}
       AND ${saoPauloInclusiveRangeSql('l.iniciado_em', '$2', '$3')}
  `
}

function presenterSql() {
  return `
    SELECT ap_v2.apresentadora_id::text AS apresentadora_id,
           COUNT(DISTINCT l.id)::int AS lives,
           COALESCE(SUM(${presenterGmvShareSql('l', 'ap_v2')}), 0)::float AS gmv
      FROM lives l
      ${presenterFanoutSql({ live: 'l', rateio: 'ap_v2' })}
     WHERE l.tenant_id = $1::uuid
       AND ${officialEndedLiveSql('l')}
       AND ${saoPauloInclusiveRangeSql('l.iniciado_em', '$2', '$3')}
       AND ap_v2.apresentadora_id IS NOT NULL
     GROUP BY ap_v2.apresentadora_id
  `
}

async function createDb() {
  const db = new PGlite()
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE apresentadoras (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      user_id uuid,
      nome text
    );
    CREATE TABLE lives (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      apresentador_id uuid,
      status text NOT NULL,
      iniciado_em timestamptz NOT NULL,
      encerrado_em timestamptz,
      arquivada_em timestamptz,
      uniao_destino_id uuid,
      uniao_desfeita_em timestamptz,
      cabine_id uuid,
      ads_gmv numeric,
      manual_gmv numeric,
      fat_gerado numeric
    );
    CREATE TABLE live_apresentadoras_v2 (
      live_id uuid NOT NULL,
      tenant_id uuid NOT NULL,
      apresentadora_id uuid NOT NULL,
      gmv_rateado numeric,
      percentual_rateio numeric,
      papel text,
      segundos_rateio int
    );
    CREATE TABLE apresentadora_live_submissoes (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      apresentadora_id uuid NOT NULL,
      status text NOT NULL,
      gmv_declarado numeric
    );
    INSERT INTO apresentadoras (id, tenant_id, user_id, nome) VALUES
      ('${EDJA}', '${TENANT}', '${EDJA_USER}', 'Edja'),
      ('${DEFINIR}', '${TENANT}', '${DEFINIR_USER}', 'À DEFINIR'),
      ('${ANA}', '${TENANT}', '${ANA_USER}', 'Ana'),
      ('${BIA}', '${TENANT}', NULL, 'Bia');
  `)
  return db
}

async function insertLive(db, row) {
  await db.query(`
    INSERT INTO lives (
      id, tenant_id, apresentador_id, status, iniciado_em, encerrado_em,
      arquivada_em, uniao_destino_id, uniao_desfeita_em, cabine_id,
      ads_gmv, manual_gmv, fat_gerado
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
  `, [
    row.id, TENANT, row.user ?? null, row.status ?? 'encerrada', row.iniciado_em,
    row.encerrado_em ?? row.iniciado_em, row.arquivada_em ?? null,
    row.uniao_destino_id ?? null, row.uniao_desfeita_em ?? null, row.cabine_id ?? null,
    row.ads_gmv === undefined ? null : row.ads_gmv,
    row.manual_gmv === undefined ? null : row.manual_gmv,
    row.fat_gerado === undefined ? null : row.fat_gerado,
  ])
}

describe('uniform live count', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('keeps archived lives out of the count and out of GMV', async () => {
    db = await createDb()
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000001', user: EDJA_USER, iniciado_em: '2026-09-10T15:00:00Z', ads_gmv: 100 })
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000002', user: EDJA_USER, iniciado_em: '2026-09-11T15:00:00Z', ads_gmv: 563.4, arquivada_em: '2026-09-12T12:00:00Z' })
    const brand = await db.query(brandSql(), [TENANT, FROM, TO])
    const people = await db.query(presenterSql(), [TENANT, FROM, TO])
    expect(brand.rows[0]).toMatchObject({ lives: 1, gmv_presente: '100' })
    expect(people.rows).toEqual([expect.objectContaining({ apresentadora_id: EDJA, lives: 1, gmv: 100 })])
  })

  it('counts each rateio holder once and the brand once', async () => {
    db = await createDb()
    const liveId = '10000000-0000-4000-8000-000000000010'
    await insertLive(db, { id: liveId, user: EDJA_USER, iniciado_em: '2026-09-10T15:00:00Z', ads_gmv: 100 })
    await db.exec(`
      INSERT INTO live_apresentadoras_v2 (live_id, tenant_id, apresentadora_id, gmv_rateado, percentual_rateio, papel)
      VALUES
        ('${liveId}', '${TENANT}', '${EDJA}', 40, 40, 'principal'),
        ('${liveId}', '${TENANT}', '${BIA}', 60, 60, 'apoio');
    `)
    const brand = await db.query(brandSql(), [TENANT, FROM, TO])
    const people = await db.query(presenterSql(), [TENANT, FROM, TO])
    expect(brand.rows[0].lives).toBe(1)
    expect(people.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ apresentadora_id: EDJA, lives: 1, gmv: 40 }),
      expect.objectContaining({ apresentadora_id: BIA, lives: 1, gmv: 60 }),
    ]))
    expect(people.rows).toHaveLength(2)
  })

  it('does not credit the live user when the rateio belongs to someone else', async () => {
    db = await createDb()
    const liveId = '9ac82847-226c-4087-83bb-137ebef6e769'
    await insertLive(db, { id: liveId, user: EDJA_USER, iniciado_em: '2026-09-10T15:00:00Z', ads_gmv: 200 })
    await db.exec(`
      INSERT INTO live_apresentadoras_v2 (live_id, tenant_id, apresentadora_id, gmv_rateado, percentual_rateio, papel)
      VALUES ('${liveId}', '${TENANT}', '${DEFINIR}', 200, 100, 'principal');
    `)
    const people = await db.query(presenterSql(), [TENANT, FROM, TO])
    expect(people.rows).toEqual([expect.objectContaining({ apresentadora_id: DEFINIR, lives: 1, gmv: 200 })])
  })

  it('attributes a live without rateio to its user', async () => {
    db = await createDb()
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000020', user: ANA_USER, iniciado_em: '2026-09-10T15:00:00Z', ads_gmv: 80 })
    const people = await db.query(presenterSql(), [TENANT, FROM, TO])
    expect(people.rows).toEqual([expect.objectContaining({ apresentadora_id: ANA, lives: 1, gmv: 80 })])
  })

  it('does not increment official lives for a pending submission', async () => {
    db = await createDb()
    await db.exec(`
      INSERT INTO apresentadora_live_submissoes (id, tenant_id, apresentadora_id, status, gmv_declarado)
      VALUES ('10000000-0000-4000-8000-000000000030', '${TENANT}', '${EDJA}', 'pendente', 19.99);
    `)
    const brand = await db.query(brandSql(), [TENANT, FROM, TO])
    const pending = await db.query(`SELECT COUNT(*)::int AS total FROM apresentadora_live_submissoes WHERE status = 'pendente'`)
    expect(brand.rows[0].lives).toBe(0)
    expect(pending.rows[0].total).toBe(1)
  })

  it('keeps a stored GMV of zero and a live without a cabine', async () => {
    db = await createDb()
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000040', user: ANA_USER, iniciado_em: '2026-09-10T15:00:00Z', ads_gmv: 0, cabine_id: null })
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000041', user: null, iniciado_em: '2026-09-11T15:00:00Z', cabine_id: null })
    const brand = await db.query(brandSql(), [TENANT, FROM, TO])
    const people = await db.query(presenterSql(), [TENANT, FROM, TO])
    expect(brand.rows[0].lives).toBe(2)
    expect(people.rows).toEqual([expect.objectContaining({ apresentadora_id: ANA, lives: 1, gmv: 0 })])
  })

  it('counts a São Paulo month edge in September and leaves October out', async () => {
    db = await createDb()
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000050', user: ANA_USER, iniciado_em: '2026-09-01T02:59:59Z', ads_gmv: 1 })
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000051', user: ANA_USER, iniciado_em: '2026-09-01T03:00:00Z', ads_gmv: 2 })
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000052', user: ANA_USER, iniciado_em: '2026-10-01T00:30:00Z', ads_gmv: 3 })
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000053', user: ANA_USER, iniciado_em: '2026-10-01T02:59:59Z', ads_gmv: 4 })
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000054', user: ANA_USER, iniciado_em: '2026-10-01T03:00:00Z', ads_gmv: 5 })
    const september = await db.query(brandSql(), [TENANT, FROM, TO])
    const october = await db.query(brandSql(), [TENANT, '2026-10-01', '2026-10-31'])
    expect(september.rows[0]).toMatchObject({ lives: 3, gmv_presente: '9' })
    expect(october.rows[0]).toMatchObject({ lives: 1, gmv_presente: '5' })
  })

  it('counts the active union destination once and skips an in-progress live', async () => {
    db = await createDb()
    const destination = '10000000-0000-4000-8000-000000000060'
    await insertLive(db, { id: destination, user: ANA_USER, iniciado_em: '2026-09-10T15:00:00Z', ads_gmv: 10 })
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000061', user: ANA_USER, iniciado_em: '2026-09-10T15:00:00Z', ads_gmv: 99, uniao_destino_id: destination })
    await insertLive(db, { id: '10000000-0000-4000-8000-000000000062', user: ANA_USER, iniciado_em: '2026-09-10T18:00:00Z', ads_gmv: 7, status: 'em_andamento' })
    const brand = await db.query(brandSql(), [TENANT, FROM, TO])
    expect(brand.rows[0]).toMatchObject({ lives: 1, gmv_presente: '10' })
  })
})
