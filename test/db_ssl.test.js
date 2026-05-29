import { describe, expect, it } from 'vitest'

import { resolveDbSslConfig } from '../src/utils/db-ssl.js'

describe('resolveDbSslConfig', () => {
  it('does not request SSL for local PostgreSQL URLs', () => {
    expect(resolveDbSslConfig('postgresql://postgres:postgres@localhost:5432/livelab_test', {})).toBe(false)
    expect(resolveDbSslConfig('postgresql://postgres:postgres@127.0.0.1:5432/livelab_test', {})).toBe(false)
  })

  it('keeps SSL enabled by default for remote databases', () => {
    expect(resolveDbSslConfig('postgresql://user:pass@db.railway.internal:5432/railway', {})).toEqual({
      rejectUnauthorized: true,
    })
  })

  it('honors sslmode and certificate verification overrides', () => {
    expect(resolveDbSslConfig('postgresql://user:pass@db.example.com:5432/app?sslmode=disable', {})).toBe(false)
    expect(resolveDbSslConfig('postgresql://user:pass@db.example.com:5432/app', { PGSSLMODE: 'require' })).toEqual({
      rejectUnauthorized: true,
    })
    expect(
      resolveDbSslConfig('postgresql://user:pass@db.example.com:5432/app', {
        DB_SSL_REJECT_UNAUTHORIZED: 'false',
      }),
    ).toEqual({ rejectUnauthorized: false })
  })
})
