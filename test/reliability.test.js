import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { createReadinessProbe, registerReadiness } from '../src/services/readiness.js'
import { backupScriptPath, executeBackup, runOffsiteBackup } from '../src/jobs/offsite-backup.js'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('database readiness', () => {
  it('reports unavailable without leaking connection errors', async () => {
    const app = Fastify()
    app.decorate('db', { query: vi.fn().mockRejectedValue(new Error('postgres://secret@private-host')) })
    registerReadiness(app)
    const response = await app.inject('/readyz')
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ ok: false })
    expect(response.headers['cache-control']).toBe('no-store')
    await app.close()
  })
  it('shares concurrent probes and retries after an outage', async () => {
    vi.useFakeTimers()
    const query = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({ rows: [{ '?column?': 1 }] })
    const probe = createReadinessProbe({ query })
    expect(await Promise.all(Array.from({ length: 20 }, () => probe()))).toEqual(Array(20).fill(false))
    expect(query).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5001)
    expect(await probe()).toBe(true)
    expect(query).toHaveBeenCalledTimes(2)
  })
  it('bounds a stalled pool without issuing more database work', async () => {
    vi.useFakeTimers()
    const query = vi.fn(() => new Promise(() => {}))
    const probe = createReadinessProbe({ query })
    const result = probe()
    await vi.advanceTimersByTimeAsync(3001)
    expect(await result).toBe(false)
    expect(await probe()).toBe(false)
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('offsite backup coordination', () => {
  it('stops foreground/background descendants and removes private dumps on timeout', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'livelab-backup-timeout-'))
    const script = join(fixtureDir, 'hanging.sh')
    const report = join(fixtureDir, 'report.json')
    const heartbeat = join(fixtureDir, 'heartbeat')
    vi.stubEnv('BACKUP_TEST_REPORT', report)
    vi.stubEnv('BACKUP_TEST_HEARTBEAT', heartbeat)
    vi.stubEnv('BACKUP_TEST_NODE', process.execPath)
    writeFileSync(script, `#!/usr/bin/env bash\ntrap '' TERM\n"$BACKUP_TEST_NODE" -e '
      const fs = require("fs");process.on("SIGTERM",()=>{});
      fs.writeFileSync(process.env.BACKUP_TEST_REPORT,JSON.stringify({tmp:process.env.TMPDIR}));
      fs.writeFileSync(process.env.TMPDIR+"/private-dump","private");
      setInterval(()=>fs.writeFileSync(process.env.BACKUP_TEST_HEARTBEAT,String(Date.now())),10);
    ' &\nwait\n`)
    try {
      await expect(executeBackup('bash', [script], { timeout: 500, stopGraceMs: 100 })).rejects.toThrow('timed out')
      expect(existsSync(JSON.parse(readFileSync(report, 'utf8')).tmp)).toBe(false)
      const lastHeartbeat = readFileSync(heartbeat, 'utf8')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(readFileSync(heartbeat, 'utf8')).toBe(lastHeartbeat)
    } finally { rmSync(fixtureDir, { recursive: true, force: true }) }
  })

  function fixture({ acquired = true, unlockError = false } = {}) {
    const client = { query: vi.fn(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired }] }
      if (unlockError) throw new Error('connection gone')
      return { rows: [] }
    }), release: vi.fn() }
    return { client, app: { db: { pool: { connect: vi.fn().mockResolvedValue(client) } }, log: { info: vi.fn(), error: vi.fn() } } }
  }
  it('uses the actual repository script and argument-based execution', async () => {
    const { app, client } = fixture()
    const run = vi.fn().mockResolvedValue({})
    expect(existsSync(backupScriptPath)).toBe(true)
    expect(await runOffsiteBackup(app, { run })).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('bash', [backupScriptPath], expect.objectContaining({ timeout: 1800000 }))
    expect(client.release).toHaveBeenCalled()
  })
  it('does not execute twice across replicas', async () => {
    const { app, client } = fixture({ acquired: false })
    const run = vi.fn()
    expect(await runOffsiteBackup(app, { run })).toEqual({ skipped: true })
    expect(run).not.toHaveBeenCalled()
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalled()
  })
  it('reports a sanitized failure and releases the lock', async () => {
    vi.stubEnv('SENTRY_DSN', 'test-only')
    const { app, client } = fixture()
    const report = vi.fn()
    expect(await runOffsiteBackup(app, { run: vi.fn().mockRejectedValue(new Error('secret connection URL')), report })).toEqual({ ok: false })
    expect(report.mock.calls[0][0].message).toBe('Offsite database backup failed')
    expect(JSON.stringify(app.log.error.mock.calls)).not.toContain('secret')
    expect(client.query.mock.calls[1][0]).toContain('pg_advisory_unlock')
  })
  it('destroys the pooled connection if its lock cannot be released', async () => {
    const { app, client } = fixture({ unlockError: true })
    await runOffsiteBackup(app, { run: vi.fn().mockResolvedValue({}) })
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error)
  })
})
