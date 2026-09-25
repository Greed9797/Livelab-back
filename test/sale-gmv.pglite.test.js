import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

import { officialLineCommissionExpr, officialLineGmvExpr } from '../src/lib/sale-gmv-sql.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const LIVE = 'dad1a09a-ee3a-46d8-b45a-a116f6984fd2'
const PRESENTER = 'd1479e32-1d69-4edd-802b-c2105cf03d81'

async function createDb() {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE lives (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      ads_gmv numeric,
      manual_gmv numeric,
      fat_gerado numeric
    );
    CREATE TABLE vendas_atribuidas (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      origem text NOT NULL,
      origem_id uuid,
      apresentadora_id uuid,
      gmv numeric,
      comissao_apresentadora numeric,
      status_aprovacao text
    );
  `)
  return db
}

function reportSql() {
  return `
    SELECT (${officialLineGmvExpr('va')})::float AS gmv,
           (${officialLineCommissionExpr('va', 'comissao_apresentadora')})::float AS comissao
      FROM vendas_atribuidas va
     WHERE va.id = $1
  `
}

describe('relatório de comissão lê o GMV oficial da live', () => {
  let db

  afterEach(async () => {
    await db?.close()
  })

  it('manual_gmv definido e fat_gerado diferente: GMV e base da comissão seguem manual_gmv', async () => {
    db = await createDb()
    await db.query(
      `INSERT INTO lives (id, tenant_id, ads_gmv, manual_gmv, fat_gerado)
       VALUES ($1, $2, NULL, 1592, 2533.69)`,
      [LIVE, TENANT],
    )
    await db.query(
      `INSERT INTO vendas_atribuidas
         (id, tenant_id, origem, origem_id, apresentadora_id, gmv, comissao_apresentadora, status_aprovacao)
       VALUES ($1, $2, 'live', $3, $4, 2533.69, 25.34, 'pendente_aprovacao')`,
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', TENANT, LIVE, PRESENTER],
    )

    const { rows } = await db.query(reportSql(), ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
    expect(rows[0].gmv).toBeCloseTo(1592, 2)
    expect(rows[0].comissao).toBeCloseTo(15.92, 2)
  })

  it('GMV gravado zero continua zero e não herda o manual', async () => {
    db = await createDb()
    await db.query(
      `INSERT INTO lives (id, tenant_id, manual_gmv, fat_gerado) VALUES ($1, $2, 1592, 2533.69)`,
      [LIVE, TENANT],
    )
    await db.query(
      `INSERT INTO vendas_atribuidas
         (id, tenant_id, origem, origem_id, gmv, comissao_apresentadora)
       VALUES ($1, $2, 'live', $3, 0, 0)`,
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', TENANT, LIVE],
    )

    const { rows } = await db.query(reportSql(), ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
    expect(rows[0].gmv).toBe(0)
    expect(rows[0].comissao).toBe(0)
  })

  it('live sem nenhum GMV não transforma a comissão gravada em zero', async () => {
    db = await createDb()
    await db.query(
      `INSERT INTO lives (id, tenant_id, ads_gmv, manual_gmv, fat_gerado) VALUES ($1, $2, NULL, NULL, NULL)`,
      [LIVE, TENANT],
    )
    await db.query(
      `INSERT INTO vendas_atribuidas
         (id, tenant_id, origem, origem_id, gmv, comissao_apresentadora)
       VALUES ($1, $2, 'live', $3, 100, 4)`,
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', TENANT, LIVE],
    )

    const { rows } = await db.query(reportSql(), ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
    expect(rows[0].gmv).toBeNull()
    expect(rows[0].comissao).toBe(4)
  })
})
