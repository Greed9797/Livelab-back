import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const tenant = '11111111-1111-4111-8111-111111111111'
let db

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    INSERT INTO tenants VALUES ('${tenant}');
    INSERT INTO users VALUES ('44444444-4444-4444-8444-444444444444');
  `)
  const sql = await readFile(new URL('../migrations/189_rh_colaboradores.sql', import.meta.url), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente

  const sql190 = await readFile(new URL('../migrations/190_rh_comissao_pct.sql', import.meta.url), 'utf8')
  await db.exec(sql190)
  await db.exec(sql190) // idempotente
})

afterAll(async () => {
  await db?.close()
})

describe('schema RH (189)', () => {
  it('insere e lê colaborador com salario_fixo NUMERIC(15,2)', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const { rows } = await db.query(
      `INSERT INTO rh_colaboradores (id, tenant_id, nome, salario_fixo)
       VALUES ($1::uuid, $2::uuid, 'Ana', 1500.50)
       RETURNING id, nome, salario_fixo`,
      [id, tenant],
    )
    expect(rows[0].nome).toBe('Ana')
    expect(rows[0].salario_fixo).toBe('1500.50')

    const sel = await db.query(
      `SELECT nome, salario_fixo FROM rh_colaboradores WHERE id = $1::uuid`,
      [id],
    )
    expect(sel.rows[0]).toEqual({ nome: 'Ana', salario_fixo: '1500.50' })
  })

  it('calcula total gerado da folha', async () => {
    const colaboradorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await db.query(
      `INSERT INTO rh_colaboradores (id, tenant_id, nome, salario_fixo)
       VALUES ($1::uuid, $2::uuid, 'Bruno', 1500.50)`,
      [colaboradorId, tenant],
    )
    const { rows } = await db.query(
      `INSERT INTO rh_folha_mensal
         (tenant_id, colaborador_id, competencia, salario_fixo, comissao, bonus, descontos)
       VALUES ($1::uuid, $2::uuid, '2026-11-01', 1500.50, 100, 50, 25)
       RETURNING total`,
      [tenant, colaboradorId],
    )
    expect(Number(rows[0].total)).toBe(1625.5)
  })

  it('rejeita segunda folha para o mesmo colaborador e competencia', async () => {
    const colaboradorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    await db.query(
      `INSERT INTO rh_colaboradores (id, tenant_id, nome)
       VALUES ($1::uuid, $2::uuid, 'Carla')`,
      [colaboradorId, tenant],
    )
    const insert = () => db.query(
      `INSERT INTO rh_folha_mensal
         (tenant_id, colaborador_id, competencia, salario_fixo)
       VALUES ($1::uuid, $2::uuid, '2026-11-01', 100)`,
      [tenant, colaboradorId],
    )
    await insert()
    await expect(insert()).rejects.toThrow()
  })

  it('rejeita competencia fora do primeiro dia e salario_fixo negativo', async () => {
    const colaboradorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    await db.query(
      `INSERT INTO rh_colaboradores (id, tenant_id, nome)
       VALUES ($1::uuid, $2::uuid, 'Davi')`,
      [colaboradorId, tenant],
    )
    await expect(db.query(
      `INSERT INTO rh_folha_mensal
         (tenant_id, colaborador_id, competencia, salario_fixo)
       VALUES ($1::uuid, $2::uuid, '2026-11-02', 100)`,
      [tenant, colaboradorId],
    )).rejects.toThrow()

    await expect(db.query(
      `INSERT INTO rh_colaboradores (tenant_id, nome, salario_fixo)
       VALUES ($1::uuid, 'Negativo', -1)`,
      [tenant],
    )).rejects.toThrow()
  })

  it('grava comissao_pct e rejeita valor fora de 0..100', async () => {
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const { rows } = await db.query(
      `INSERT INTO rh_colaboradores (id, tenant_id, nome, comissao_pct)
       VALUES ($1::uuid, $2::uuid, 'Eva', 5.00)
       RETURNING comissao_pct`,
      [id, tenant],
    )
    expect(rows[0].comissao_pct).toBe('5.00')

    const sel = await db.query(
      `SELECT comissao_pct FROM rh_colaboradores WHERE id = $1::uuid`,
      [id],
    )
    expect(sel.rows[0].comissao_pct).toBe('5.00')

    await expect(db.query(
      `INSERT INTO rh_colaboradores (tenant_id, nome, comissao_pct)
       VALUES ($1::uuid, 'Fora', 101)`,
      [tenant],
    )).rejects.toThrow()
  })
})
