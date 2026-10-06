import { describe, expect, it, vi } from 'vitest'

const { registrarLiquidacao, registrarEstorno } = vi.hoisted(() => ({
  registrarLiquidacao: vi.fn(),
  registrarEstorno: vi.fn(),
}))
vi.mock('../src/services/financeiro-liquidacoes-command.js', () => ({ registrarLiquidacao, registrarEstorno }))

import { desfazerPagamentoApresentadora, registrarPagamentoApresentadora } from '../src/services/apresentadoras-pagamentos.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const apresentadoraId = '22222222-2222-4222-8222-222222222222'
const linhaId = '33333333-3333-4333-8333-333333333333'

function db({ linha = null, fatos = [] } = {}) {
  return {
    query: vi.fn(async (sql) => {
      const s = String(sql)
      if (s.includes('SELECT id FROM apresentadoras')) return { rows: [{ id: apresentadoraId }] }
      if (s.includes('FROM apresentadora_pagamentos') && s.includes('competencia::text')) return { rows: linha ? [linha] : [] }
      if (s.includes('FROM financeiro_estornos') && s.includes('idempotencia_chave')) return { rows: [] }
      if (s.includes('FROM financeiro_liquidacoes l LEFT JOIN financeiro_estornos')) return { rows: fatos }
      return { rows: [] }
    }),
  }
}

describe('FIN03 apresentadoras writer', () => {
  it('registra a baixa parcial pelo writer canônico com origem UUID da linha e chave operacional', async () => {
    const conn = db()
    await registrarPagamentoApresentadora(conn, {
      tenantId, apresentadoraId, mes: '2026-10', componente: 'fixo', valorPago: '30.01',
      dataPagamento: '2026-10-05', userId: '44444444-4444-4444-8444-444444444444', chaveOperacao: 'op-30-01',
    })
    expect(registrarLiquidacao).toHaveBeenCalledWith(conn, expect.objectContaining({
      tenantId, origemTipo: 'apresentadora_pagamento', origemId: expect.any(String),
      valor: '30.01', data: '2026-10-05', idempotenciaChave: 'op-30-01',
      comandoOrigem: 'apresentadoras.pagar',
    }))
  })

  it('desfaz via estorno, sem apagar a projeção legada', async () => {
    const conn = db({ linha: { id: linhaId, valor_pago: '30.01' }, fatos: [{ id: '55555555-5555-4555-8555-555555555555', saldo: '30.01' }] })
    await desfazerPagamentoApresentadora(conn, {
      tenantId, apresentadoraId, mes: '2026-10', componente: 'fixo',
      chaveOperacao: 'op-estorno', hoje: '2026-10-06', userId: '44444444-4444-4444-8444-444444444444',
    })
    expect(registrarEstorno).toHaveBeenCalledWith(conn, expect.objectContaining({
      tenantId, idempotenciaChave: 'op-estorno', comandoOrigem: 'apresentadoras.desfazer',
    }))
  })
})
