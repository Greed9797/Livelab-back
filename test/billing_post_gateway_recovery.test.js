import { describe, expect, it, vi } from 'vitest'

const tenant = '11111111-1111-4111-8111-111111111111'
const cliente = '22222222-2222-4222-8222-222222222222'
const live = '33333333-3333-4333-8333-333333333333'

const gateway = vi.hoisted(() => ({ charges: 0 }))
vi.mock('../src/services/appmax.js', () => ({
  buscarOuCriarCustomer: vi.fn(async () => 'customer-1'),
  gerarIdempotencyKey: vi.fn(() => 'cycle-key'),
  criarCobranca: vi.fn(async () => {
    gateway.charges += 1
    return { id: 'gateway-1', invoiceUrl: 'https://gateway.test/boleto' }
  }),
}))
import { runBillingTick, startBillingEngine } from '../src/jobs/billing_engine.js'

function makePool() {
  const state = { boletoCreated: false, gatewayId: null, failedLocalUpdate: false, connects: 0 }
  const billingClient = {
    release: vi.fn(),
    query: vi.fn(async (sql) => {
      const text = String(sql).trim()
      if (text.includes('FROM tenants WHERE id')) return { rows: [{ gateway_api_key: 'configured' }] }
      if (text.includes('FROM lives l')) return { rows: [{ cliente_id: cliente, id: live, marca_id: '44444444-4444-4444-8444-444444444444', comissao: 100, tipo_cobranca: 'fixo_mais_comissao' }] }
      if (text.includes('FROM vendas_atribuidas')) return { rows: [] }
      if (text.includes('INSERT INTO boletos')) {
        if (!state.boletoCreated) {
          state.boletoCreated = true
          return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (text.includes('SELECT id, gateway_id FROM boletos')) return { rows: [{ id: '55555555-5555-4555-8555-555555555555', gateway_id: state.gatewayId }] }
      if (text.includes('SELECT nome, cpf, cnpj')) return { rows: [{ nome: 'Cliente', email: 'cliente@test', gateway_customer_id: 'customer-1' }] }
      if (text.includes('UPDATE boletos SET gateway_id')) {
        state.gatewayId = 'gateway-1'
        if (!state.failedLocalUpdate) {
          state.failedLocalUpdate = true
          throw new Error('falha local depois da confirmação')
        }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  const pool = {
    state,
    billingClient,
    connect: vi.fn(async () => {
      const n = state.connects++
      if (n % 2 === 0) return { query: vi.fn(async () => ({ rows: [{ acquired: true }] })), release: vi.fn() }
      return billingClient
    }),
    query: vi.fn(async () => ({ rows: [{ id: tenant }] })),
  }
  return pool
}

describe('billing: recuperação após confirmação externa', () => {
  it('preserva a chave local e não chama gateway de novo no retry', async () => {
    gateway.charges = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pool = makePool()
    await startBillingEngine(pool)
    await runBillingTick(pool, { hoje: new Date('2026-09-16T15:00:00-03:00') })
    await runBillingTick(pool, { hoje: new Date('2026-09-16T15:00:00-03:00') })
    expect(gateway.charges).toBe(1)
    expect(pool.state.gatewayId).toBe('gateway-1')
  })
})
