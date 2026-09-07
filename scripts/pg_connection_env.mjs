// Keep the connection URL/password out of process arguments and command logs.
import { spawn } from 'node:child_process'
const [command, ...args] = process.argv.slice(2)
if (!['pg_dump', 'pg_restore', 'psql'].includes(command)) process.exit(2)
try {
  const url = new URL(process.env.DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('protocol')
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '15',
    PGSSLMODE: url.searchParams.get('sslmode') || 'require' }
  for (const [key, target] of [['sslrootcert', 'PGSSLROOTCERT'], ['sslcert', 'PGSSLCERT'], ['sslkey', 'PGSSLKEY']]) {
    if (url.searchParams.has(key)) env[target] = url.searchParams.get(key)
  }
  delete env.DATABASE_URL
  const child = spawn(command, args, { env, stdio: 'inherit' })
  child.on('error', () => { console.error('[backup] PostgreSQL client could not start'); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
} catch {
  console.error('[backup] Invalid PostgreSQL connection configuration')
  process.exitCode = 2
}
