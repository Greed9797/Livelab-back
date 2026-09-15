import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
}))

import { runBillingTick, startBillingEngine } from '../src/jobs/billing_engine.js'
import { mergeLives, undoLiveMerge } from '../src/services/live-merge.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveA = '77777777-7777-4777-8777-777777777777'
const liveB = '88888888-8888-4888-8888-888888888888'
const unionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

class TenantTransactionLock {
  owner = null
  waiters = []

  async query(owner, sql, params = []) {
    const text = String(sql)
    if (text.includes('live-finance:tenant-lock')) {
      expect(params).toEqual([tenantId])
      if (this.owner && this.owner !== owner) {
        await new Promise((resolve) => this.waiters.push(resolve))
      }
      this.owner = owner
    }
    if ((text === 'COMMIT' || text === 'ROLLBACK') && this.owner === owner) {
      this.owner = null
      this.waiters.shift()?.()
    }
  }
}

function billingPool(lock, { selected, releaseSelection } = {}) {
  const lockClient = {
    query: vi.fn(async (sql) => {
      if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  const billingClient = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql).trim()
      await lock.query('billing', text, params)
      if (text.includes('FROM tenants WHERE id')) return { rows: [{ gateway_api_key: 'configured' }] }
      if (text.includes('FROM lives')) {
        selected.resolve()
        if (releaseSelection) await releaseSelection.promise
        return { rows: [] }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  let connection = 0
  return {
    billingClient,
    connect: vi.fn(async () => (connection++ === 0 ? lockClient : billingClient)),
    query: vi.fn(async (sql) => String(sql).includes('FROM tenants')
      ? { rows: [{ id: tenantId }] }
      : { rows: [] }),
  }
}

function mergeDb(lock, { reachedBoundary, releaseBoundary }) {
  return {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql).trim()
      await lock.query('merge', text, params)
      if (text.includes('live-merge:existing-request')) {
        reachedBoundary.resolve()
        await releaseBoundary.promise
        throw new Error('merge test boundary')
      }
      return { rows: [], rowCount: 0 }
    }),
  }
}

function undoDb(lock, { reachedBoundary, releaseBoundary }) {
  return {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql).trim()
      await lock.query('undo', text, params)
      if (text.includes('live-merge:load-union')) {
        reachedBoundary.resolve()
        await releaseBoundary.promise
        throw new Error('undo test boundary')
      }
      return { rows: [], rowCount: 0 }
    }),
  }
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('billing e união serializam mudanças financeiras por tenant', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('merge vencedor termina antes de o billing selecionar o snapshot de lives', async () => {
    const lock = new TenantTransactionLock()
    const mergeReached = deferred()
    const releaseMerge = deferred()
    const billingSelected = deferred()
    let selectedBeforeMergeFinished = false
    billingSelected.promise.then(() => { selectedBeforeMergeFinished = true })

    const mergePromise = mergeLives(mergeDb(lock, {
      reachedBoundary: mergeReached,
      releaseBoundary: releaseMerge,
    }), {
      tenantId,
      userId: null,
      liveIds: [liveA, liveB],
      previewToken: 'lm1:test',
      requestId: '14141414-1414-4414-8414-141414141414',
      motivo: null,
      metricasPorTrecho: true,
    }).catch(() => undefined)
    await mergeReached.promise

    const pool = billingPool(lock, { selected: billingSelected })
    await startBillingEngine(pool)
    const billingPromise = runBillingTick(pool, { hoje: new Date('2026-09-16T15:00:00-03:00') })
    await nextTurn()
    const raced = selectedBeforeMergeFinished

    releaseMerge.resolve()
    await Promise.all([mergePromise, billingPromise])
    expect(raced).toBe(false)
    const billingSql = pool.billingClient.query.mock.calls.map(([sql]) => String(sql))
    expect(billingSql.findIndex((sql) => sql === 'BEGIN'))
      .toBeLessThan(billingSql.findIndex((sql) => sql.includes('live-finance:tenant-lock')))
    expect(billingSql.findIndex((sql) => sql.includes('live-finance:tenant-lock')))
      .toBeLessThan(billingSql.findIndex((sql) => sql.includes('FROM lives')))
  })

  it('billing vencedor fecha seu snapshot antes de o merge consultar idempotência ou travar lives', async () => {
    const lock = new TenantTransactionLock()
    const billingSelected = deferred()
    const releaseBilling = deferred()
    const pool = billingPool(lock, { selected: billingSelected, releaseSelection: releaseBilling })
    await startBillingEngine(pool)
    const billingPromise = runBillingTick(pool, { hoje: new Date('2026-09-16T15:00:00-03:00') })
    await billingSelected.promise

    const mergeReached = deferred()
    const releaseMerge = deferred()
    let mergeReachedBeforeBillingFinished = false
    mergeReached.promise.then(() => { mergeReachedBeforeBillingFinished = true })
    const mergePromise = mergeLives(mergeDb(lock, {
      reachedBoundary: mergeReached,
      releaseBoundary: releaseMerge,
    }), {
      tenantId,
      userId: null,
      liveIds: [liveA, liveB],
      previewToken: 'lm1:test',
      requestId: '14141414-1414-4414-8414-141414141414',
      motivo: null,
      metricasPorTrecho: true,
    }).catch(() => undefined)
    await nextTurn()
    const raced = mergeReachedBeforeBillingFinished

    releaseBilling.resolve()
    await billingPromise
    await mergeReached.promise
    releaseMerge.resolve()
    await mergePromise
    expect(raced).toBe(false)
  })

  it('undo vencedor restaura a topologia antes de o billing selecionar o snapshot', async () => {
    const lock = new TenantTransactionLock()
    const undoReached = deferred()
    const releaseUndo = deferred()
    const undoPromise = undoLiveMerge(undoDb(lock, {
      reachedBoundary: undoReached,
      releaseBoundary: releaseUndo,
    }), {
      tenantId,
      userId: null,
      unionId,
      requestId: '15151515-1515-4515-8515-151515151515',
      motivo: null,
    }).catch(() => undefined)
    await undoReached.promise

    const billingSelected = deferred()
    let selectedBeforeUndoFinished = false
    billingSelected.promise.then(() => { selectedBeforeUndoFinished = true })
    const pool = billingPool(lock, { selected: billingSelected })
    await startBillingEngine(pool)
    const billingPromise = runBillingTick(pool, { hoje: new Date('2026-09-16T15:00:00-03:00') })
    await nextTurn()
    const raced = selectedBeforeUndoFinished

    releaseUndo.resolve()
    await Promise.all([undoPromise, billingPromise])
    expect(raced).toBe(false)
  })
})
