import { afterEach, describe, expect, it, vi } from 'vitest'

import { criarCobranca } from '../src/services/appmax.js'

describe('Appmax: idempotência de cobrança', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.APPMAX_API_KEY
    delete process.env.APPMAX_APP_ID
  })

  it('encaminha a chave determinística no pedido e no pagamento', async () => {
    process.env.APPMAX_API_KEY = 'test-key'
    process.env.APPMAX_APP_ID = 'test-app'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'order-1' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'payment-1', url: 'https://gateway.test/boleto' } }) })
    vi.stubGlobal('fetch', fetchMock)

    await criarCobranca({
      asaasCustomerId: 'customer-1', valor: 100, vencimento: '2026-09-05',
      descricao: 'Competência 2026-08', externalReference: 'boleto-1',
      idempotencyKey: 'cycle-key',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('cycle-key:order')
    expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe('cycle-key')
  })
})
