// Job auto-encerra lives 'em_andamento' >24h sem snapshot recente.

import { describe, expect, it, vi } from 'vitest'
import { runEncerrarLivesZumbiTick } from '../src/jobs/encerrar_lives_zumbi.js'

vi.mock('../src/services/tiktok-connector-manager.js', () => ({
  stop: vi.fn().mockResolvedValue(undefined),
}))

function makeApp({ targets, clientQueryMock }) {
  const release = vi.fn()
  const clientQuery = clientQueryMock ?? vi.fn(async (sql) => {
    if (String(sql).includes('UPDATE lives')) return { rowCount: 1, rows: [{ id: 'live-1' }] }
    if (String(sql).includes('UPDATE cabines')) return { rowCount: 1, rows: [] }
    return { rows: [], rowCount: 0 }
  })
  const poolQuery = vi.fn().mockResolvedValue({ rows: targets ?? [] })
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      query: poolQuery,
      pool: { connect: vi.fn(async () => ({ query: clientQuery, release })) },
    },
    _clientQuery: clientQuery,
  }
}

describe('encerrar_lives_zumbi job', () => {
  it('encerra lives candidatas e libera cabine', async () => {
    const targets = [
      { id: 'live-1', tenant_id: 'tenant-1', cabine_id: 'cab-1' },
      { id: 'live-2', tenant_id: 'tenant-1', cabine_id: 'cab-2' },
    ]
    const app = makeApp({ targets })
    const result = await runEncerrarLivesZumbiTick(app)
    expect(result.encerradas).toBe(2)
    expect(result.errors).toBe(0)

    const updateLives = app._clientQuery.mock.calls.filter(([s]) =>
      String(s).includes('UPDATE lives'))
    expect(updateLives.length).toBe(2)
    const updateCabines = app._clientQuery.mock.calls.filter(([s]) =>
      String(s).includes('UPDATE cabines'))
    expect(updateCabines.length).toBe(2)
  })

  it('retorna early quando não há targets', async () => {
    const app = makeApp({ targets: [] })
    const result = await runEncerrarLivesZumbiTick(app)
    expect(result.encerradas).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('skip quando UPDATE lives retorna rowCount=0 (já encerrada por outro tick)', async () => {
    const clientQuery = vi.fn(async (sql) => {
      const s = String(sql)
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] }
      if (s.includes('set_config')) return { rows: [] }
      if (s.includes('UPDATE lives')) return { rowCount: 0, rows: [] }
      return { rows: [], rowCount: 0 }
    })
    const app = makeApp({
      targets: [{ id: 'live-1', tenant_id: 'tenant-1', cabine_id: 'cab-1' }],
      clientQueryMock: clientQuery,
    })
    const result = await runEncerrarLivesZumbiTick(app)
    expect(result.encerradas).toBe(0)
    // Cabine não é tocada se UPDATE lives = 0
    const updateCabines = app._clientQuery.mock.calls.filter(([s]) =>
      String(s).includes('UPDATE cabines'))
    expect(updateCabines.length).toBe(0)
  })
})
