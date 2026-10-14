import { describe, it, expect, vi } from 'vitest'
import { executeTool } from '../src/mcp/tools.js'
const identity = { user: { id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222', ativo: true, papel: 'franqueado', token_version: 1 }, scope: 'livelab:finance:read', tokenVersion: 1 }
describe('MCP com financeiro atual', () => {
  it('usa previsto efetivo, conserva pagamento registrado e não soma saldo cancelado', async () => {
    const rows = [
      { id: 'a', natureza: 'custo', tipo: 'manual', valor_previsto: 100, valor_pago: 20, cancelado_em: '2026-10-01T00:00:00Z' },
      { id: 'b', natureza: 'custo', tipo: 'manual', valor_previsto: 50, valor_pago: 0, cancelado_em: null },
    ]
    const app = { jwt: { sign: () => 'synthetic-internal-token' }, inject: vi.fn(async () => ({ statusCode: 200, payload: JSON.stringify(rows), json: () => rows })) }
    const result = await executeTool(app, identity, 'consultar_custos', { inicio: '2026-10', fim: '2026-10' })
    expect(result.dados).toMatchObject({ total_custos: 70, total_previsto_registrado: 150, total_pago_registrado: 20, por_categoria: { manual: 70 } })
    expect(app.inject.mock.calls[0][0].method).toBe('GET')
  })
})
