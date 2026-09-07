import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Sentry from '@sentry/node'

export const backupScriptPath = fileURLToPath(new URL('../../scripts/pg_dump_offsite.sh', import.meta.url))

export async function executeBackup(_command, [scriptPath], { timeout = 1800000, stopGraceMs = 5000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'livelab-backup-job-'))
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore', env: { ...process.env, TMPDIR: directory } })
      let timedOut = false, closed = false, forced = false, graceTimer
      const signalGroup = (signal) => { if (child.pid) { try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } } }
      const timer = setTimeout(() => {
        timedOut = true
        signalGroup('SIGTERM')
        // Await group termination before releasing the database lock. Bash can
        // exit before pg_dump/aws descendants; always complete the group cleanup.
        graceTimer = setTimeout(() => {
          signalGroup('SIGKILL')
          forced = true
          if (closed) reject(new Error('Backup process timed out'))
        }, stopGraceMs)
      }, timeout)
      child.once('error', () => { clearTimeout(timer); clearTimeout(graceTimer); reject(new Error('Backup process could not start')) })
      child.once('close', (code) => {
        closed = true
        clearTimeout(timer)
        if (timedOut) { if (forced) reject(new Error('Backup process timed out')); return }
        if (code === 0) resolve(); else reject(new Error('Backup process failed'))
      })
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function reportBackupFailure(error) {
  Sentry.withScope((scope) => { scope.setTag('job', 'offsite-backup'); Sentry.captureException(error) })
}

export async function runOffsiteBackup(app, { run = executeBackup, report = reportBackupFailure } = {}) {
  let client
  let locked = false
  let releaseError
  try {
    client = await app.db.pool.connect()
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext('livelab:offsite-backup')) AS acquired")
    locked = result.rows[0]?.acquired === true
    if (!locked) return { skipped: true }
    await run('bash', [backupScriptPath], { timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 })
    app.log.info('[backup] archive uploaded; restoration must be verified separately')
    return { ok: true }
  } catch {
    // Never forward child stderr/argv/environment to logs or error telemetry.
    app.log.error('[backup] offsite backup failed')
    if (process.env.SENTRY_DSN) report(new Error('Offsite database backup failed'))
    return { ok: false }
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext('livelab:offsite-backup'))") }
      catch { releaseError = new Error('Backup lock cleanup failed') }
    }
    client?.release(releaseError)
  }
}
