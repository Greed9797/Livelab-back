// Integração com Postgres real. Só roda com TEST_PG_URL (ex.: postgres://u@localhost:55433/db)
// em banco onde as migrations até 172 (com `tenants`, `apresentadoras`, `apresentadora_pagamentos`) já foram aplicadas.
import fs from 'node:fs'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import {
  cancelarPagamentoApresentadora,
  desfazerPagamentoApresentadora,
  listarPagamentosApresentadoras,
  reativarPagamentoApresentadora,
  registrarPagamentoApresentadora,
} from '../src/services/apresentadoras-pagamentos.js'

const url = process.env.TEST_PG_URL
const MES = '2026-09'
const HOJE = '2026-09-05'

describe.skipIf(!url)('apresentadoras-pagamentos (Postgres real)', () => {
  it('dois lançamentos por pessoa/mês; baixa independente; desfazer; um componente não bloqueia o outro', async () => {
    const pool = new pg.Pool({ connectionString: url })
    const sql = fs.readFileSync('migrations/172_apresentadora_pagamentos_componente.sql', 'utf8')
    await pool.query(sql)
    await pool.query(sql)
    const sql174 = fs.readFileSync('migrations/174_apresentadora_pagamentos_cancelamento.sql', 'utf8')
    await pool.query(sql174)
    await pool.query(sql174)
    const t = (await pool.query(`INSERT INTO tenants (nome) VALUES ('t-apres-pag') RETURNING id`)).rows[0].id
    const apId = (await pool.query(
      `INSERT INTO apresentadoras (tenant_id, nome, fixo) VALUES ($1, 'Ana', 2700) RETURNING id`, [t],
    )).rows[0].id
    await pool.query(
      `INSERT INTO apresentadora_remuneracao_adicionais
         (tenant_id, apresentadora_id, competencia, tipo, descricao, valor)
       VALUES ($1, $2, '2026-09-01', 'bonificacao', 'bonus', 160)`, [t, apId])
    const por = (itens, c) => itens.find((i) => i.componente === c && i.apresentadora_id === apId)
    const listar = (hoje = HOJE) => listarPagamentosApresentadoras(pool, {
      tenantId: t, inicio: `${MES}-01`, fim: `${MES}-30`, hoje,
    })
    const rowsPg = () => pool.query(
      `SELECT componente, valor_pago FROM apresentadora_pagamentos
        WHERE tenant_id = $1 AND apresentadora_id = $2 AND competencia = '2026-09-01'
        ORDER BY componente`, [t, apId])
    try {
      const itens = await listar()
      expect(itens).toHaveLength(2)
      expect(por(itens, 'fixo')).toMatchObject({
        id: `apresentadora:${apId}:${MES}:fixo`,
        componente: 'fixo',
        competencia: '2026-09-01',
        data_vencimento: '2026-09-10',
        valor_previsto: 2700,
        valor_pago: 0,
        status: 'pendente',
      })
      expect(por(itens, 'variavel')).toMatchObject({
        id: `apresentadora:${apId}:${MES}:variavel`,
        componente: 'variavel',
        competencia: '2026-09-01',
        data_vencimento: '2026-10-15',
        valor_previsto: 160,
        valor_pago: 0,
        status: 'previsto',
      })

      await registrarPagamentoApresentadora(pool, {
        tenantId: t, apresentadoraId: apId, mes: MES, componente: 'fixo', dataPagamento: '2026-09-09',
      })
      const aposFixo = await listar()
      expect(por(aposFixo, 'fixo')).toMatchObject({ status: 'pago', valor_pago: 2700, data_pagamento: '2026-09-09' })
      expect(por(aposFixo, 'variavel')).toMatchObject({ status: 'previsto', valor_pago: 0, data_pagamento: null })
      expect((await rowsPg()).rows.map((r) => r.componente)).toEqual(['fixo'])

      await registrarPagamentoApresentadora(pool, {
        tenantId: t, apresentadoraId: apId, mes: MES, componente: 'variavel', dataPagamento: '2026-10-15',
      })
      const ambos = await listar('2026-10-16')
      expect(por(ambos, 'fixo')).toMatchObject({ status: 'pago', valor_pago: 2700 })
      expect(por(ambos, 'variavel')).toMatchObject({ status: 'pago', valor_pago: 160, data_pagamento: '2026-10-15' })
      expect((await rowsPg()).rows.map((r) => r.componente)).toEqual(['fixo', 'variavel'])

      expect(await desfazerPagamentoApresentadora(pool, {
        tenantId: t, apresentadoraId: apId, mes: MES, componente: 'fixo',
      })).toBe(true)
      const aposDesfazerFixo = await listar('2026-10-16')
      expect(por(aposDesfazerFixo, 'fixo')).toMatchObject({ status: 'atrasado', valor_pago: 0, data_pagamento: null })
      expect(por(aposDesfazerFixo, 'variavel')).toMatchObject({ status: 'pago', valor_pago: 160 })
      expect((await rowsPg()).rows.map((r) => r.componente)).toEqual(['variavel'])

      await registrarPagamentoApresentadora(pool, {
        tenantId: t, apresentadoraId: apId, mes: MES, componente: 'fixo', dataPagamento: '2026-09-10',
      })
      const viceVersa = await listar('2026-10-16')
      expect(por(viceVersa, 'fixo')).toMatchObject({ status: 'pago', valor_pago: 2700, data_pagamento: '2026-09-10' })
      expect(por(viceVersa, 'variavel')).toMatchObject({ status: 'pago', valor_pago: 160 })

      expect(await desfazerPagamentoApresentadora(pool, {
        tenantId: t, apresentadoraId: apId, mes: MES, componente: 'variavel',
      })).toBe(true)
      const aposDesfazerVar = await listar('2026-10-16')
      expect(por(aposDesfazerVar, 'fixo')).toMatchObject({ status: 'pago', valor_pago: 2700 })
      expect(por(aposDesfazerVar, 'variavel')).toMatchObject({ status: 'atrasado', valor_pago: 0, data_pagamento: null })
      expect((await rowsPg()).rows.map((r) => r.componente)).toEqual(['fixo'])

      // Cancelamento: variável (virtual) -> cancelado -> pagar 409 -> reativar apaga a linha (volta a virtual).
      const arg = { tenantId: t, apresentadoraId: apId, mes: MES, componente: 'variavel' }
      const item = await cancelarPagamentoApresentadora(pool, { ...arg, motivo: 'saiu' })
      expect(item).toMatchObject({ status: 'cancelado', virtual: false, valor_pago: 0, data_pagamento: null, cancelado_motivo: 'saiu' })
      expect(item.cancelado_em).toEqual(expect.any(String))
      await expect(registrarPagamentoApresentadora(pool, { ...arg, dataPagamento: '2026-10-15' }))
        .rejects.toMatchObject({ code: 'CUSTO_CANCELADO' })
      expect((await rowsPg()).rows.map((r) => r.componente)).toEqual(['fixo', 'variavel'])
      await reativarPagamentoApresentadora(pool, arg)
      expect((await rowsPg()).rows.map((r) => r.componente)).toEqual(['fixo'])
      expect(por(await listar('2026-10-16'), 'variavel')).toMatchObject({ status: 'atrasado', valor_pago: 0 })
      expect(await reativarPagamentoApresentadora(pool, arg)).toBeNull()

      // Fixo pago integral não cancela.
      await expect(cancelarPagamentoApresentadora(pool, { ...arg, componente: 'fixo' }))
        .rejects.toMatchObject({ code: 'CANCELAMENTO_INVALIDO' })
    } finally {
      await pool.query('DELETE FROM apresentadora_pagamentos WHERE tenant_id = $1', [t])
      await pool.query('DELETE FROM apresentadora_remuneracao_adicionais WHERE tenant_id = $1', [t])
      await pool.query('DELETE FROM apresentadoras WHERE tenant_id = $1', [t])
      await pool.query('DELETE FROM tenants WHERE id = $1', [t])
      await pool.end()
    }
  })
})
