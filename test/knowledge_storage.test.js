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

  it('verifies an existing private bucket when Supabase reports duplicate as 400', async () => {
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_KEY
    process.env.SUPABASE_URL = 'https://storage.example.test'
    process.env.SUPABASE_SERVICE_KEY = 'secret-test-only'
    try {
      const status = await ensureKnowledgePrivateBucket({
        fetchImpl: async (url) => url.endsWith('/bucket')
          ? { ok: false, status: 400, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ public: false }) },
      })
      expect(status).toEqual({ configured: true, ok: true })
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY
      else process.env.SUPABASE_SERVICE_KEY = previousKey
    }
  })

  it('retries a transient provider failure and recovers', async () => {
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_KEY
    process.env.SUPABASE_URL = 'https://storage.example.test'
    process.env.SUPABASE_SERVICE_KEY = 'secret-test-only'
    let createCalls = 0
    try {
      const status = await ensureKnowledgePrivateBucket({
        retryDelays: [0],
        fetchImpl: async (url) => {
          if (url.endsWith('/bucket')) {
            createCalls += 1
            return createCalls === 1
              ? { ok: false, status: 503, json: async () => ({}) }
              : { ok: false, status: 400, json: async () => ({}) }
          }
          return { ok: true, status: 200, json: async () => ({ public: false }) }
        },
      })
      expect(status).toEqual({ configured: true, ok: true })
      expect(createCalls).toBe(2)
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY
      else process.env.SUPABASE_SERVICE_KEY = previousKey
    }
  })

  it('bounds a stalled provider request', async () => {
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_KEY
    process.env.SUPABASE_URL = 'https://storage.example.test'
    process.env.SUPABASE_SERVICE_KEY = 'secret-test-only'
    try {
      const status = await ensureKnowledgePrivateBucket({
        timeoutMs: 5,
        fetchImpl: async (_url, options) => {
          if (!options.signal) throw new Error('missing timeout signal')
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
          })
        },
      })
      expect(status).toMatchObject({ configured: true, ok: false, error: 'storage request timed out' })
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY
      else process.env.SUPABASE_SERVICE_KEY = previousKey
    }
  })

  it('stops after the configured retry budget when the provider stays down', async () => {
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_KEY
    process.env.SUPABASE_URL = 'https://storage.example.test'
    process.env.SUPABASE_SERVICE_KEY = 'secret-test-only'
    let attempts = 0
    try {
      const status = await ensureKnowledgePrivateBucket({
        retryDelays: [0, 0],
        fetchImpl: async () => {
          attempts += 1
          return { ok: false, status: 503, json: async () => ({}) }
        },
      })
      expect(status).toEqual({ configured: true, ok: false, error: 'storage bucket create 503' })
      expect(attempts).toBe(3)
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
