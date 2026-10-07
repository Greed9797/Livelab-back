import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'
import { listarReceitasAvulsas } from '../src/services/receitas-avulsas.js'

it('seleciona vencimentos independentemente da competência sem cruzar tenants', async () => {
  const db = new PGlite()
  const tenantId = '11111111-1111-4111-8111-111111111111'
  try {
    await db.exec(`CREATE TABLE receitas_avulsas (
      id uuid, tenant_id uuid, descricao text, grupo text, valor_previsto numeric,
      valor_pago numeric DEFAULT 0, observacao text, data_vencimento date,
      data_pagamento date, competencia date, perdido_em timestamptz,
      perdido_motivo text, perdido_por uuid, valor_perdido numeric, criado_em timestamptz
    )`)
    for (const [n, competencia, vencimento, tenant] of [
      [1, '2026-11-01', '2026-10-15', tenantId],
      [2, '2024-01-01', '2026-09-15', tenantId],
      [3, '2026-10-01', '2026-11-15', tenantId],
      [4, '2026-11-01', '2026-10-15', '22222222-2222-4222-8222-222222222222'],
    ]) {
      await db.query(`INSERT INTO receitas_avulsas
        (id, tenant_id, descricao, grupo, valor_previsto, competencia, data_vencimento)
        VALUES ($1, $2, 'Serviço', 'servico', 100, $3, $4)`,
      [`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, tenant, competencia, vencimento])
    }
    const opts = { tenantId, inicio: '2026-10', fim: '2026-10', hoje: '2026-10-07' }
    const competencia = await listarReceitasAvulsas(db, opts)
    expect(competencia.map(i => i.competencia)).toEqual(['2026-10-01'])
    const painel = await listarReceitasAvulsas(db, { ...opts, vencimentoAte: '2026-10-31' })
    expect(painel).toHaveLength(3)
    const receita = await listarReceitasAvulsas(db, { ...opts, vencimentoDe: '2026-10-01', vencimentoAte: '2026-10-31' })
    expect(receita).toHaveLength(2)
    expect(receita.some(i => i.competencia === '2026-11-01')).toBe(true)
    expect(receita.some(i => i.competencia === '2024-01-01')).toBe(false)
  } finally { await db.close() }
}, 120_000)
