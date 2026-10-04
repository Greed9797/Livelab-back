// Integração com Postgres real (WP-A). Só roda com TEST_PG_URL num banco com o schema completo
// (apply_migrations.js, inclui 173). Ciclo: cancelar imposto → /dre/mes sem o imposto no previsto
// → pagar 409 → reativar → pagar.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import { criarReceitaAvulsa, receberReceitaAvulsa } from '../src/services/receitas-avulsas.js'
import {
  atualizarConfigFinanceiro, calcularDreMes, cancelarImposto, consultarLancamentos, pagarImposto, reativarImposto,
} from '../src/services/financeiro-agregador.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-10-15'
const MES = '2026-10'

describe.skipIf(!url)('imposto cancelável (Postgres real)', () => {
  let pool
  let t
  const q = (sql, params) => pool.query(sql, params)
  const imposto = async () => (await consultarLancamentos(pool, { tenantId: t, inicio: MES, fim: MES, hoje: HOJE }))
    .itens.find((i) => i.origem === 'imposto')

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-imposto-cancelar') RETURNING id`)).rows[0].id
    await atualizarConfigFinanceiro(pool, t, { aliquota_imposto_pct: 10 })
    // Recebido em setembro = 1000 → imposto de outubro = 100.
    const av = await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Consultoria', grupo: 'servico', valor_previsto: 1000, data_vencimento: '2026-09-10' }, hoje: HOJE })
    await receberReceitaAvulsa(pool, { tenantId: t, id: av.id, valorPago: 1000, dataPagamento: '2026-09-12', hoje: HOJE })
  })

  afterAll(async () => {
    if (!pool) return
    for (const tb of ['receitas_avulsas', 'custos']) await q(`DELETE FROM ${tb} WHERE tenant_id = $1`, [t]).catch(() => {})
    await q('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {})
    await pool.end()
  })

  it('cancelar → DRE sem o imposto no previsto → pagar 409 → reativar → pagar', async () => {
    expect(await imposto()).toMatchObject({ valor_previsto: 100, status: 'pendente', virtual: true })
    const antes = (await calcularDreMes(pool, { tenantId: t, mes: MES, hoje: HOJE })).atual.imposto.previsto
    expect(antes).toBe(100)

    const cancelado = await cancelarImposto(pool, { tenantId: t, mes: MES, motivo: 'isento', hoje: HOJE })
    expect(cancelado).toMatchObject({ status: 'cancelado', virtual: false, valor_pago: 0, cancelado_motivo: 'isento' })
    const dre = await calcularDreMes(pool, { tenantId: t, mes: MES, hoje: HOJE })
    expect(dre.atual.imposto.previsto).toBe(0)
    expect(dre.caixa).toMatchObject({ origem: 'padrao' })

    await expect(pagarImposto(pool, { tenantId: t, mes: MES, hoje: HOJE })).rejects.toMatchObject({ statusCode: 409, code: 'CUSTO_CANCELADO' })

    const reativado = await reativarImposto(pool, { tenantId: t, mes: MES, hoje: HOJE })
    expect(reativado).toMatchObject({ status: 'pendente', virtual: true })
    expect((await q(`SELECT 1 FROM custos WHERE tenant_id = $1 AND tipo = 'imposto'`, [t])).rowCount).toBe(0)

    const pago = await pagarImposto(pool, { tenantId: t, mes: MES, hoje: HOJE })
    expect(pago).toMatchObject({ status: 'pago', valor_pago: 100 })
    await expect(cancelarImposto(pool, { tenantId: t, mes: MES, hoje: HOJE })).rejects.toMatchObject({ statusCode: 409, code: 'JA_PAGO' })
  })
})
