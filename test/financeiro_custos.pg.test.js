// Integração com Postgres real. Só roda com TEST_PG_URL (ex.: postgres://u@localhost:55433/db)
// em banco onde as migrations até 164 (com `tenants`, `custos`) já foram aplicadas.
import fs from 'node:fs'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { gerarCustosDoMes, listarCustos } from '../src/services/custos-plano.js'

const url = process.env.TEST_PG_URL
describe.skipIf(!url)('custos-plano (Postgres real)', () => {
  it('migration 164 é reaplicável; geração idempotente; listagem com tenant explícito', async () => {
    const pool = new pg.Pool({ connectionString: url })
    const sql = fs.readFileSync('migrations/164_custos_reset_recorrentes_parcelas.sql', 'utf8')
    await pool.query(sql)
    await pool.query(sql)
    const t = (await pool.query(`INSERT INTO tenants (nome) VALUES ('t-custos') RETURNING id`)).rows[0].id
    const t2 = (await pool.query(`INSERT INTO tenants (nome) VALUES ('t-outro') RETURNING id`)).rows[0].id
    await pool.query(
      `INSERT INTO custos_recorrentes (tenant_id, nome, valor, dia_vencimento, inicio) VALUES ($1,'Aluguel',100,31,'2026-01-01')`, [t])
    const a = await gerarCustosDoMes(pool, { tenantId: t, mes: '2026-09' })
    const b = await gerarCustosDoMes(pool, { tenantId: t, mes: '2026-09' })
    expect(a.criados).toBe(1)
    expect(b.criados).toBe(0)
    const itens = await listarCustos(pool, { tenantId: t, inicio: '2026-09', fim: '2026-10', hoje: '2026-09-30' })
    expect(itens.map((i) => i.virtual)).toEqual([false, true])
    expect(await listarCustos(pool, { tenantId: t2, inicio: '2026-09', fim: '2026-10', hoje: '2026-09-30' })).toEqual([])
    await pool.query('DELETE FROM custos WHERE tenant_id = $1', [t])
    await pool.query('DELETE FROM custos_recorrentes WHERE tenant_id = $1', [t])
    await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [[t, t2]])
    await pool.end()
  })
})
