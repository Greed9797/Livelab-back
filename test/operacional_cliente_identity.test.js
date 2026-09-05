import { describe, expect, it, vi } from 'vitest'

import { getClienteOperacional } from '../src/lib/operacional.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const clienteId = '22222222-2222-4222-8222-222222222222'

describe('getClienteOperacional — lives legadas por marca do cliente', () => {
  it('inclui fallback brand-only sem mudar a precedência do cliente explícito', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('FROM clientes')) return { rows: [{ id: clienteId, nome: 'Cliente' }] }
      if (sql.includes('WITH marca_scope AS')) return { rows: [{}] }
      return { rows: [] }
    })

    await getClienteOperacional({ query }, {
      tenantId, clienteId, startDate: '2026-06-01', endDate: '2026-06-30',
    })

    const metricsSql = String(query.mock.calls.find(([sql]) => sql.includes('WITH marca_scope AS'))[0])
    expect(metricsSql).toContain('LEFT JOIN marcas marca_cliente ON marca_cliente.id = l.marca_id')
    expect(metricsSql).toContain('l.cliente_id = $1')
    expect(metricsSql).toContain('l.cliente_id IS NULL AND marca_cliente.cliente_id = $1')
    expect(metricsSql).toContain('l.id NOT IN')

    const livesSql = String(query.mock.calls.find(([sql]) => sql.includes('WITH venda_live_marca AS'))[0])
    expect(livesSql).toContain('COALESCE(vl.marca_id, marca_cliente.id) AS marca_id')
    expect(livesSql).toContain('COALESCE(vl.marca_nome, marca_cliente.nome) AS marca_nome')
    expect(livesSql).toContain('OR vl.live_id IS NOT NULL')
    expect(livesSql).toContain('l.cliente_id IS NULL AND marca_cliente.cliente_id = $1')
  })
})
