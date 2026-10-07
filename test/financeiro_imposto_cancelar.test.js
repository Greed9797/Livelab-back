// Imposto cancelável (WP-A): cancelar → status 'cancelado' fora do previsto; reativar; pagar cancelado → 409.
// Banco mockado com uma única linha `custos tipo='imposto'` em memória.
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import {
  cancelarImposto, desfazerImposto, pagarImposto, reativarImposto, totalizarLancamentos,
} from '../src/services/financeiro-agregador.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '99999999-9999-4999-8999-999999999999'
const HOJE = '2026-10-15'
const MES = '2026-10'

// Recebido em set/2026 = 800 → imposto de out = 80 (10%).
function fakeDb() {
  let row = null
  const calls = []
  const db = {
    calls,
    get row() { return row },
    async query(sql, params = []) {
      calls.push(sql)
      if (sql.includes('FROM tenants')) return { rows: [{ aliquota_imposto_pct: 10, data_corte: null, saldo_abertura: 0 }] }
      if (sql.includes('WITH origens AS')) return { rows: [{
        id: 'recebimento-setembro', origem_tipo: 'receita_titulo', origem_id: 'titulo-setembro',
        natureza: 'receita', origem: 'marca_fixo', tipo: 'liquidacao', fonte: 'canonico',
        data: '2026-09-10', valor: '800.00',
      }] }
      if (sql.includes("SELECT id, valor, valor_pago")) {
        return { rows: row ? [{ ...row, competencia: `${MES}-01`, data_vencimento: `${MES}-20` }] : [] }
      }
      if (sql.startsWith('INSERT INTO custos')) {
        if (!row) {
          row = sql.includes('cancelado_em')
            ? { id: 'c-imp', valor: params[2], valor_pago: 0, data_pagamento: null, observacao: null, cancelado_em: '2026-10-15T12:00:00.000Z', cancelado_por: params[5], cancelado_motivo: params[6] }
            : { id: 'c-imp', valor: params[2], valor_pago: params[5], data_pagamento: params[6], observacao: params[7], cancelado_em: null, cancelado_por: null, cancelado_motivo: null }
        } else if (sql.includes('cancelado_em')) {
          row = { ...row, cancelado_em: row.cancelado_em ?? '2026-10-15T12:00:00.000Z', cancelado_motivo: params[6] ?? row.cancelado_motivo }
        } else {
          row = { ...row, valor_pago: params[5], data_pagamento: params[6] }
        }
        return { rows: [], rowCount: 1 }
      }
      if (sql.startsWith('DELETE FROM custos')) {
        const ok = row && (!sql.includes('cancelado_em IS NOT NULL') || (row.cancelado_em && !(row.valor_pago > 0)))
        if (ok) row = null
        return { rows: ok ? [{ id: 'c-imp' }] : [] }
      }
      if (sql.includes('SET cancelado_em = NULL')) {
        const ok = row?.cancelado_em
        if (ok) row = { ...row, cancelado_em: null, cancelado_motivo: null, cancelado_por: null }
        return { rows: ok ? [{ id: 'c-imp' }] : [] }
      }
      if (sql.includes('SET valor_pago = 0')) {
        const ok = row?.cancelado_em
        if (ok) row = { ...row, valor_pago: 0, data_pagamento: null }
        return { rows: ok ? [{ id: 'c-imp' }] : [] }
      }
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
    },
  }
  return db
}

describe('cancelarImposto / reativarImposto', () => {
  it('cancelar imposto virtual materializa com valor_pago 0 e devolve status cancelado', async () => {
    const db = fakeDb()
    const item = await cancelarImposto(db, { tenantId: TENANT, mes: MES, motivo: ' isento ', actorUserId: USER, hoje: HOJE })
    expect(db.row).toMatchObject({ valor: 80, valor_pago: 0, cancelado_por: USER, cancelado_motivo: 'isento' })
    expect(item).toMatchObject({
      origem: 'imposto', status: 'cancelado', virtual: false, valor_previsto: 80, valor_pago: 0,
      cancelado_motivo: 'isento', cancelado_por: USER,
    })
    expect(item.cancelado_em).toBe('2026-10-15T12:00:00.000Z')
    // saldo cancelado sai do previsto de custos (totais): a pagar = 0
    expect(totalizarLancamentos([item]).custo).toMatchObject({ previsto: 80, cancelado: 80, pendente: 0, atrasado: 0 })
  })

  it('reativar sem baixa apaga a linha (volta a ser calculado) e sem cancelamento → 404', async () => {
    const db = fakeDb()
    await cancelarImposto(db, { tenantId: TENANT, mes: MES, hoje: HOJE })
    const item = await reativarImposto(db, { tenantId: TENANT, mes: MES, hoje: HOJE })
    expect(db.row).toBeNull()
    expect(item).toMatchObject({ status: 'pendente', virtual: true, cancelado_em: null })
    await expect(reativarImposto(db, { tenantId: TENANT, mes: MES, hoje: HOJE })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('reativar com baixa parcial só limpa cancelado_*', async () => {
    const db = fakeDb()
    await cancelarImposto(db, { tenantId: TENANT, mes: MES, hoje: HOJE })
    db.row.valor_pago = 30
    const item = await reativarImposto(db, { tenantId: TENANT, mes: MES, hoje: HOJE })
    expect(db.row).toMatchObject({ valor_pago: 30, cancelado_em: null })
    expect(item).toMatchObject({ valor_pago: 30, status: 'parcial', cancelado_em: null })
  })

  it('pagar imposto cancelado → 409 CUSTO_CANCELADO', async () => {
    const db = fakeDb()
    await cancelarImposto(db, { tenantId: TENANT, mes: MES, hoje: HOJE })
    await expect(pagarImposto(db, { tenantId: TENANT, mes: MES, hoje: HOJE })).rejects.toMatchObject({ statusCode: 409, code: 'CUSTO_CANCELADO' })
  })

})

describe('rotas PATCH /impostos/:mes/cancelar|reativar', () => {
  async function buildApp(db) {
    const app = Fastify()
    app.decorate('requirePapel', () => async () => {})
    app.decorate('withTenant', async (_t, fn) => fn(db))
    app.addHook('onRequest', async (req) => { req.user = { tenant_id: TENANT, sub: USER, papel: 'financeiro' } })
    await app.register(financeiroRoutes)
    return app
  }

  it('cancelar → 200 item cancelado; pagar depois → 409 com code; reativar → 200', async () => {
    const app = await buildApp(fakeDb())
    const c = await app.inject({ method: 'PATCH', url: `/v1/financeiro/impostos/${MES}/cancelar`, payload: { motivo: 'isento' } })
    expect(c.statusCode).toBe(200)
    expect(c.json()).toMatchObject({ status: 'cancelado', cancelado_motivo: 'isento' })
    const p = await app.inject({ method: 'PATCH', url: `/v1/financeiro/impostos/${MES}/pagar`, payload: {} })
    expect(p.statusCode).toBe(409)
    expect(p.json()).toMatchObject({ code: 'CUSTO_CANCELADO' })
    const r = await app.inject({ method: 'PATCH', url: `/v1/financeiro/impostos/${MES}/reativar` })
    expect(r.statusCode).toBe(200)
    expect(r.json().status).not.toBe('cancelado')
    await app.close()
  })

  it('valida mes, motivo > 300 e campos extras → 400', async () => {
    const app = await buildApp(fakeDb())
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/impostos/2026-1/cancelar', payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/impostos/${MES}/cancelar`, payload: { motivo: 'x'.repeat(301) } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/impostos/${MES}/cancelar`, payload: { foo: 1 } })).statusCode).toBe(400)
    await app.close()
  })
})
