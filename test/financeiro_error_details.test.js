import { describe, expect, it } from 'vitest'
import { detalhesReconciliacao } from '../src/lib/financeiro-error-details.js'

describe('referências de reconciliação financeira', () => {
  it('preserva apenas referências saneadas, sem duplicar eventos da mesma obrigação', () => {
    const item = { origem_tipo: 'receita_titulo', origem_id: '00000000-0000-4000-8000-000000000001', motivo: 'saldo_divergente' }
    expect(detalhesReconciliacao({ code: 'FINANCIAL_RECONCILIATION_REQUIRED', divergencias: [
      { ...item, tenant_id: 'private', valor: 20, sql: 'private' }, item,
      { ...item, origem_id: 'invalid' }, { ...item, motivo: 'unexpected' }, null,
    ] })).toEqual({ divergencias: [item] })
  })
  it('não expõe propriedades de outros erros', () => {
    expect(detalhesReconciliacao({ code: 'OTHER', divergencias: [{ segredo: 'private' }] })).toEqual({})
    expect(detalhesReconciliacao(null)).toEqual({})
  })
})
