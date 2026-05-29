// Job recalcular_comissoes: detecta vendas_atribuidas com comissao=0 e gmv>0
// no mês corrente e dispara recalcularVendasAtribuidasApresentadora.

import { describe, expect, it, vi } from 'vitest'

import { runRecalcularComissoesTick } from '../src/jobs/recalcular_comissoes.js'

vi.mock('../src/routes/vendas_atribuidas.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    recalcularVendasAtribuidasApresentadora: vi.fn().mockResolvedValue({ updated: 2 }),
  }
})

import { recalcularVendasAtribuidasApresentadora } from '../src/routes/vendas_atribuidas.js'

function makeApp({ targets, clientQueryMock }) {
  const release = vi.fn()
  const clientQuery = clientQueryMock ?? vi.fn().mockResolvedValue({ rows: [] })
  const poolQuery = vi.fn().mockResolvedValue({ rows: targets ?? [] })
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      query: poolQuery,
      pool: { connect: vi.fn(async () => ({ query: clientQuery, release })) },
    },
    _release: release,
    _clientQuery: clientQuery,
  }
}

describe('recalcular_comissoes job', () => {
  it('recalcula apenas apresentadoras com vendas zeradas', async () => {
    const targets = [
      { tenant_id: 'tenant-1', apresentadora_id: 'ap-1' },
      { tenant_id: 'tenant-1', apresentadora_id: 'ap-2' },
    ]
    recalcularVendasAtribuidasApresentadora.mockClear()
    recalcularVendasAtribuidasApresentadora.mockResolvedValue({ updated: 2 })

    const app = makeApp({ targets })
    const result = await runRecalcularComissoesTick(app)

    expect(result.apresentadoras).toBe(2)
    expect(result.vendas).toBe(4)
    expect(result.tenants).toBe(1)
    expect(recalcularVendasAtribuidasApresentadora).toHaveBeenCalledTimes(2)
  })

  it('retorna early quando não há targets', async () => {
    recalcularVendasAtribuidasApresentadora.mockClear()
    const app = makeApp({ targets: [] })
    const result = await runRecalcularComissoesTick(app)
    expect(result.apresentadoras).toBe(0)
    expect(recalcularVendasAtribuidasApresentadora).not.toHaveBeenCalled()
  })

  it('isola erro de uma apresentadora — continua nas demais', async () => {
    const targets = [
      { tenant_id: 'tenant-1', apresentadora_id: 'ap-1' },
      { tenant_id: 'tenant-1', apresentadora_id: 'ap-2' },
    ]
    recalcularVendasAtribuidasApresentadora
      .mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ updated: 3 })

    const app = makeApp({ targets })
    const result = await runRecalcularComissoesTick(app)

    expect(result.errors).toBe(1)
    expect(result.vendas).toBe(3)
    expect(result.apresentadoras).toBe(1)
  })
})
