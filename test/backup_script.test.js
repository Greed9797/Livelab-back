import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { backupScriptPath } from '../src/jobs/offsite-backup.js'

const directories = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function runBackup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'livelab-backup-test-'))
  directories.push(dir)
  const recorder = join(dir, 'calls.jsonl')
  function executable(name, body) {
    writeFileSync(join(dir, name), `#!${process.execPath}\n${body}`, { mode: 0o700 })
  }
  executable('pg_dump', `const fs=require('fs');const args=process.argv.slice(2);const path=args.find(a=>a.startsWith('--file=')).slice(7);
    fs.appendFileSync(process.env.RECORDER,JSON.stringify({command:'dump',args,path,credentialsInEnvironment:process.env.PGPASSWORD==='test-password',urlRemoved:!process.env.DATABASE_URL})+'\\n');
    if(process.env.FAIL_DUMP){console.error('test-password');process.exit(1)}fs.writeFileSync(path,'fixture');`)
  executable('pg_restore', `if(process.env.FAIL_ARCHIVE)process.exit(1);`)
  executable('aws', `require('fs').appendFileSync(process.env.RECORDER,JSON.stringify({command:'aws',args:process.argv.slice(2),region:process.env.AWS_DEFAULT_REGION})+'\\n');if(process.env.FAIL_UPLOAD)process.exit(1);`)
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RECORDER: recorder,
    DATABASE_URL: 'postgresql://test:test-password@localhost/test', BACKUP_S3_BUCKET: 'test-backups',
    BACKUP_S3_ACCESS_KEY: 'test-only', BACKUP_S3_SECRET_KEY: 'test-only', BACKUP_S3_REGION: 'sa-east-1',
    BACKUP_S3_ENDPOINT: 'https://storage.invalid', ...overrides }
  const result = spawnSync('bash', [backupScriptPath], { env, encoding: 'utf8', timeout: 15000 })
  const calls = existsSync(recorder) ? readFileSync(recorder, 'utf8').trim().split('\n').map(JSON.parse) : []
  return { result, calls }
}

describe('offsite backup script boundaries (simulated clients)', () => {
  it('keeps credentials out of argv/output, uses region, cleans up, and never deletes backups', () => {
    const { result, calls } = runBackup()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout + result.stderr + JSON.stringify(calls)).not.toContain('test-password')
    expect(calls[0]).toMatchObject({ credentialsInEnvironment: true, urlRemoved: true })
    expect(existsSync(dirname(calls[0].path))).toBe(false)
    const uploads = calls.filter(c => c.command === 'aws')
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ region: 'sa-east-1' })
    expect(uploads[0].args).toContain('cp')
    expect(uploads[0].args).not.toContain('rm')
  })
  it('validates credentials before dumping any data', () => {
    const { result, calls } = runBackup({ BACKUP_S3_SECRET_KEY: '' })
    expect(result.status).toBe(2)
    expect(calls).toEqual([])
  })
  it.each([{ FAIL_DUMP: '1' }, { FAIL_ARCHIVE: '1' }])('does not upload after a failed dump/archive check: %o', (failure) => {
    const { result, calls } = runBackup(failure)
    expect(result.status).toBe(1)
    expect(calls.some(c => c.command === 'aws')).toBe(false)
    expect(existsSync(dirname(calls[0].path))).toBe(false)
    expect(result.stdout + result.stderr).not.toContain('test-password')
  })
  it('cleans up plaintext when upload fails', () => {
    const { result, calls } = runBackup({ FAIL_UPLOAD: '1' })
    expect(result.status).toBe(1)
    expect(existsSync(dirname(calls[0].path))).toBe(false)
  })
})
