import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { saldosCaixaInicioMeses } from '../src/services/financeiro-agregador.js'

const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'

describe('DRE anual: saldo inicial de caixa por mês (PGlite)', () => {
  let db

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE TABLE receita_titulos (
        tenant_id uuid NOT NULL, competencia date, valor_pago numeric NOT NULL DEFAULT 0, data_pagamento date
      );
      CREATE TABLE receitas_avulsas (
        tenant_id uuid NOT NULL, grupo text, competencia date, valor_pago numeric NOT NULL DEFAULT 0, data_pagamento date
      );
      CREATE TABLE custos (
        tenant_id uuid NOT NULL, tipo text, competencia date, valor_pago numeric NOT NULL DEFAULT 0, data_pagamento date
      );
      CREATE TABLE apresentadora_pagamentos (
        tenant_id uuid NOT NULL, competencia date, valor_pago numeric NOT NULL DEFAULT 0, data_pagamento date
      );
    `)
  })

  afterEach(async () => db.close())

  it('corte no meio do ano: null antes, abertura no mês do corte e competência antiga conta pela data do pagamento', async () => {
    await db.query(
      `INSERT INTO receita_titulos (tenant_id, competencia, valor_pago, data_pagamento) VALUES
       ($1, '2026-01-01', 500, '2026-07-20'),
       ($1, '2026-07-01', 200, '2026-08-02'),
       ($2, '2026-01-01', 9000, '2026-07-21')`,
      [T1, T2],
    )
    await db.query(
      `INSERT INTO receitas_avulsas (tenant_id, grupo, competencia, valor_pago, data_pagamento) VALUES
       ($1, 'aporte', '2026-07-01', 300, '2026-07-25')`, [T1],
    )
    await db.query(
      `INSERT INTO custos (tenant_id, tipo, competencia, valor_pago, data_pagamento) VALUES
       ($1, 'imposto', '2026-01-01', 50, '2026-07-28'),
       ($1, 'outros', '2026-07-01', 70, '2026-08-03')`, [T1],
    )
    await db.query(
      `INSERT INTO apresentadora_pagamentos (tenant_id, competencia, valor_pago, data_pagamento) VALUES
       ($1, '2026-06-01', 80, '2026-07-30')`, [T1],
    )

    const saldos = await saldosCaixaInicioMeses(db, {
      tenantId: T1,
      meses: ['2026-06', '2026-07', '2026-08', '2026-09'],
      config: { data_corte: '2026-07-15', saldo_abertura: 100 },
    })

    expect(Object.fromEntries(saldos)).toEqual({
      '2026-06': null,
      '2026-07': 100,
      '2026-08': 770,
      '2026-09': 900,
    })
  })

  it('saldo configurado em zero permanece 0; sem corte retorna null sem consultar movimentos', async () => {
    const zero = await saldosCaixaInicioMeses(db, {
      tenantId: T1,
      meses: ['2026-01', '2026-02'],
      config: { data_corte: '2026-01-01', saldo_abertura: 0 },
    })
    expect(Object.fromEntries(zero)).toEqual({ '2026-01': 0, '2026-02': 0 })

    const semCorte = await saldosCaixaInicioMeses(db, {
      tenantId: T1,
      meses: ['2026-01', '2026-02'],
      config: { data_corte: null, saldo_abertura: 999 },
    })
    expect(Object.fromEntries(semCorte)).toEqual({ '2026-01': null, '2026-02': null })
  })
})
