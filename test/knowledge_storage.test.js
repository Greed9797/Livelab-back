import { describe, expect, it } from 'vitest'

import { ensureKnowledgePrivateBucket } from '../src/services/knowledge-storage.js'

describe('knowledge private storage provisioning', () => {
  it('creates and verifies the bucket as private without exposing provider data', async () => {
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push({ url, options })
      return url.endsWith('/bucket')
        ? { ok: true, status: 200, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ id: 'knowledge-private', public: false, secret: 'ignored' }) }
    }
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_KEY
    process.env.SUPABASE_URL = 'https://storage.example.test'
    process.env.SUPABASE_SERVICE_KEY = 'secret-test-only'
    try {
      const status = await ensureKnowledgePrivateBucket({ fetchImpl })
      expect(status).toEqual({ configured: true, ok: true })
      expect(JSON.parse(calls[0].options.body)).toMatchObject({ id: 'knowledge-private', public: false })
      expect(calls[1].url).toContain('/bucket/knowledge-private')
      expect(status).not.toHaveProperty('secret')
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY
      else process.env.SUPABASE_SERVICE_KEY = previousKey
    }
  })

  it('fails closed when an existing bucket is public', async () => {
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_KEY
    process.env.SUPABASE_URL = 'https://storage.example.test'
    process.env.SUPABASE_SERVICE_KEY = 'secret-test-only'
    try {
      const status = await ensureKnowledgePrivateBucket({
        fetchImpl: async (url) => url.endsWith('/bucket')
          ? { ok: false, status: 409, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ public: true }) },
      })
      expect(status).toMatchObject({ configured: true, ok: false })
      expect(status.error).toMatch(/private/i)
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY
      else process.env.SUPABASE_SERVICE_KEY = previousKey
    }
  })
})
