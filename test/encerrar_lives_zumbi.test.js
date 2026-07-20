// Job auto-encerra lives 'em_andamento' >24h.

import { describe, expect, it, vi } from 'vitest'
import { runEncerrarLivesZumbiTick } from '../src/jobs/encerrar_lives_zumbi.js'

vi.mock('../src/services/tiktok-connector-manager.js', () => ({
  stop: vi.fn().mockResolvedValue(undefined),
}))

// A descoberta de zumbis roda tenant a tenant (scanPorTenant): app.db.query só
// lista os tenants; o SELECT em lives sai num client com contexto RLS.
function makeApp({ targets, clientQueryMock, tenants = ['tenant-1'] }) {
  const release = vi.fn()
  const inner = clientQueryMock ?? vi.fn(async (sql) => {
    if (String(sql).includes('UPDATE lives')) return { rowCount: 1, rows: [{ id: 'live-1' }] }
    if (String(sql).includes('UPDATE cabines')) return { rowCount: 1, rows: [] }
    return { rows: [], rowCount: 0 }
  })
  const clientQuery = vi.fn(async (sql, params) => {
    const s = String(sql)
    if (s.includes('FROM lives l') && s.includes("l.status = 'em_andamento'")) {
      return { rows: targets ?? [] }
    }
    return inner(sql, params)
  })
  const poolQuery = vi.fn(async (sql) => {
    if (String(sql).includes('FROM tenants')) return { rows: tenants.map((id) => ({ id })) }
    return { rows: [] }
  })
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      query: poolQuery,
      pool: { connect: vi.fn(async () => ({ query: clientQuery, release })) },
    },
    _clientQuery: clientQuery,
    _poolQuery: poolQuery,
  }
}

describe('encerrar_lives_zumbi job', () => {
  it('encerra lives candidatas e libera cabine', async () => {
    const targets = [
      { id: 'live-1', tenant_id: 'tenant-1', cabine_id: 'cab-1', last_snapshot_at: '2026-05-29T12:00:00.000Z' },
      { id: 'live-2', tenant_id: 'tenant-1', cabine_id: 'cab-2', last_snapshot_at: null },
    ]
    const app = makeApp({ targets })
    const result = await runEncerrarLivesZumbiTick(app)
    expect(result.encerradas).toBe(2)
    expect(result.errors).toBe(0)

    const updateLives = app._clientQuery.mock.calls.filter(([s]) =>
      String(s).includes('UPDATE lives'))
    expect(updateLives.length).toBe(2)
    expect(updateLives[0][1]).toEqual(['live-1', 'tenant-1', '2026-05-29T12:00:00.000Z'])
    expect(updateLives[1][1]).toEqual(['live-2', 'tenant-1', null])
    const updateCabines = app._clientQuery.mock.calls.filter(([s]) =>
      String(s).includes('UPDATE cabines'))
    expect(updateCabines.length).toBe(2)
  })

  it('usa limite duro de 24h mesmo quando há snapshot recente', async () => {
    const app = makeApp({ targets: [] })
    await runEncerrarLivesZumbiTick(app)

    // A varredura sai no client com contexto RLS, não no pool de sistema.
    const scan = app._clientQuery.mock.calls.find(([s]) =>
      String(s).includes("l.status = 'em_andamento'"))
    expect(scan).toBeDefined()
    const sql = String(scan[0])
    expect(sql).toContain("l.iniciado_em < NOW() - INTERVAL '24 hours'")
    expect(sql).toContain('SELECT MAX(captured_at)')
    expect(sql).not.toContain("< NOW() - INTERVAL '2 hours'")

    // E precedida de set_config do tenant na mesma transação.
    const setConfig = app._clientQuery.mock.calls.find(([s]) =>
      String(s).includes('set_config'))
    expect(setConfig?.[1]).toEqual(['tenant-1'])
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
