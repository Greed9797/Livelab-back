const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function readSslMode(databaseUrl) {
  try {
    return new URL(databaseUrl).searchParams.get('sslmode')?.toLowerCase()
  } catch {
    return null
  }
}

function readHostname(databaseUrl) {
  try {
    return new URL(databaseUrl).hostname
  } catch {
    return ''
  }
}

export function resolveDbSslConfig(databaseUrl = process.env.DATABASE_URL, env = process.env) {
  const sslMode = (env.PGSSLMODE || readSslMode(databaseUrl) || '').toLowerCase()

  if (sslMode === 'disable') return false

  if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
    return { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
  }

  if (sslMode === 'no-verify') return { rejectUnauthorized: false }

  const hostname = readHostname(databaseUrl)
  if (LOCAL_DB_HOSTS.has(hostname)) return false

  return { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
}
