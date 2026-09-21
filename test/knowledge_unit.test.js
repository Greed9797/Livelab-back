import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { knowledgeUnitRoutes } from '../src/routes/knowledge-unit.js'
import { knowledgeRoutes } from '../src/routes/knowledge.js'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const MATERIAL = '33333333-3333-4333-8333-333333333333'

function buildApp({ papel = 'franqueado', tenant = TENANT, queryResults = [] } = {}) {
  const app = Fastify()
  const queries = []
  app.decorate('authenticate', async (request) => { request.user = { sub: 'user-1', tenant_id: tenant, papel } })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user?.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  const query = vi.fn(async (sql, params) => {
    queries.push({ sql, params })
    return queryResults.shift() ?? { rows: [] }
  })
  app.decorate('db', { query, pool: { connect: vi.fn() } })
  app.decorate('withTenant', async (id, fn) => fn({ query: async (sql, params) => query(sql, [id, ...(params ?? []).filter((value) => value !== id)]) }))
  return { app, query, queries }
}

const IDEMPOTENCY_HEADER = { 'idempotency-key': 'test-create-key' }

function buildLegacyKnowledgeApp({ query = vi.fn().mockResolvedValue({ rows: [{ id: 'article-1' }] }) } = {}) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => { request.user = { sub: 'user-1', tenant_id: TENANT, papel: 'franqueador_master' } })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user?.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('db', { query, pool: { connect: vi.fn() } })
  return { app, query }
}

describe('local knowledge base security and editing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects client and automation roles before touching the database', async () => {
    for (const papel of ['cliente_parceiro', 'automacao']) {
      const { app, query } = buildApp({ papel })
      await app.register(knowledgeUnitRoutes)
      const response = await app.inject({ method: 'GET', url: '/v1/knowledge/unit/materials' })
      expect(response.statusCode).toBe(403)
      expect(query).not.toHaveBeenCalled()
      await app.close()
    }
  })

  it('lists with tenant predicate, published status and bounded pagination', async () => {
    const { app, query, queries } = buildApp({ queryResults: [{ rows: [{ id: MATERIAL }] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/knowledge/unit/materials?page=2&page_size=24&q=playbook' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ items: [{ id: MATERIAL }], page: 2, page_size: 24 })
    expect(queries[0].sql).toMatch(/m\.tenant_id = \$1/)
    expect(queries[0].sql).toMatch(/m\.status = 'published'/)
    expect(queries[0].params).toContain(TENANT)
    expect(queries[0].params).toContain(24)
    expect(queries[0].params).toContain(24)
    await app.close()
  })

  it('lets managers list inactive categories and reactivate one', async () => {
    const category = '44444444-4444-4444-8444-444444444444'
    const { app, query, queries } = buildApp({ queryResults: [
      { rows: [{ id: category, name: 'Arquivada', is_active: false }] },
      { rows: [{ id: category, name: 'Arquivada', is_active: true }] },
    ] })
    await app.register(knowledgeUnitRoutes)

    const listed = await app.inject({ method: 'GET', url: '/v1/knowledge/unit/categories?include_inactive=true' })
    const reactivated = await app.inject({ method: 'PATCH', url: `/v1/knowledge/unit/categories/${category}`, payload: { is_active: true } })

    expect(listed.statusCode).toBe(200)
    expect(queries[0].sql).not.toContain('is_active = true')
    expect(reactivated.statusCode).toBe(200)
    expect(queries[1].sql).toContain('is_active = $1')
    expect(queries[1].params).toContain(true)
    expect(query).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it('never exposes inactive categories to non-manager readers', async () => {
    const { app, queries } = buildApp({ papel: 'apresentadora', queryResults: [{ rows: [] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'GET', url: '/v1/knowledge/unit/categories?include_inactive=true' })
    expect(response.statusCode).toBe(200)
    expect(queries[0].sql).toContain('is_active = true')
    await app.close()
  })

  it('requires expected revision and returns conflict when the row was changed', async () => {
    const { app, query } = buildApp({ queryResults: [{ rows: [] }, { rows: [{ id: MATERIAL, revision: 4 }] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'PATCH', url: `/v1/knowledge/unit/materials/${MATERIAL}`, payload: { titulo: 'Nova versão', expected_revision: 3 } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ current_revision: 4 })
    expect(query).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it('keeps publication behind the transactional route', async () => {
    const { app, query } = buildApp()
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'PATCH', url: `/v1/knowledge/unit/materials/${MATERIAL}`, payload: { status: 'published', expected_revision: 1 } })
    expect(response.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('rebuilds a safe video URL on detail reload and exposes attachment filename metadata', async () => {
    const { app } = buildApp({ queryResults: [
      { rows: [{ id: MATERIAL, title: 'Vídeo', video_provider: 'youtube', video_id: 'abc_123', status: 'published' }] },
      { rows: [{ id: 'att-1', original_name: 'Guia.pdf', mime_type: 'application/pdf', byte_size: 100, state: 'ready' }] },
    ] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'GET', url: `/v1/knowledge/unit/materials/${MATERIAL}` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ video_url: 'https://www.youtube.com/watch?v=abc_123', attachments: [{ filename: 'Guia.pdf', original_name: 'Guia.pdf' }] })
    await app.close()
  })

  it('updates other fields without requiring the existing video URL again', async () => {
    const { app, query } = buildApp({ queryResults: [{ rows: [{ id: MATERIAL, title: 'Título novo', video_provider: 'youtube', video_id: 'still_here', revision: 2 }] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'PATCH', url: `/v1/knowledge/unit/materials/${MATERIAL}`, payload: { titulo: 'Título novo', expected_revision: 1 } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ video_url: 'https://www.youtube.com/watch?v=still_here' })
    expect(query.mock.calls[0][0]).not.toContain('video_id =')
    await app.close()
  })

  it('rejects active HTML and unsafe video URLs', async () => {
    const { app, query } = buildApp()
    await app.register(knowledgeUnitRoutes)
    const html = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', payload: { titulo: 'X', content_markdown: '<script>alert(1)</script>' } })
    const url = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', payload: { titulo: 'X', content_markdown: 'texto', video_provider: 'youtube', video_url: 'https://evil.example/video' } })
    expect(html.statusCode).toBe(400)
    expect(url.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a video provider and URL that do not describe the same source', async () => {
    const { app, query } = buildApp()
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', payload: { titulo: 'Vídeo', video_provider: 'youtube', video_url: 'https://panda.video/video-123' } })
    expect(response.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('allows an empty draft for the upload-first flow and validates content at publish', async () => {
    const { app, query } = buildApp({ queryResults: [{ rows: [{ id: MATERIAL, revision: 1, status: 'draft' }] }] })
    await app.register(knowledgeUnitRoutes)
    const draft = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', headers: IDEMPOTENCY_HEADER, payload: { titulo: 'Rascunho sem arquivo' } })
    expect(draft.statusCode).toBe(201)
    expect(query).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('audits material creation with tenant, actor and revision metadata only', async () => {
    const { app } = buildApp({ queryResults: [{ rows: [{ id: MATERIAL, revision: 1, status: 'draft', inserted: true }] }] })
    const auditLog = vi.fn().mockResolvedValue(undefined)
    app.decorate('audit', { log: auditLog })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', headers: IDEMPOTENCY_HEADER, payload: { titulo: 'Playbook', content_markdown: 'texto' } })
    expect(response.statusCode).toBe(201)
    expect(auditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'knowledge.material.create',
      metadata: expect.objectContaining({ tenant_id: TENANT, actor_id: 'user-1', revision: 1 }),
    }))
    expect(auditLog.mock.calls[0][1].metadata).not.toHaveProperty('content_markdown')
    await app.close()
  })

  it('marks a failed private upload as orphaned and never returns a usable attachment', async () => {
    const { app, query } = buildApp({ queryResults: [
      { rows: [{ id: MATERIAL }] },
      { rows: [{ id: 'att-1', storage_key: `${TENANT}/opaque.pdf`, original_name: 'Guia.pdf', state: 'pending' }] },
      { rows: [] },
    ] })
    await app.register(multipart)
    await app.register(knowledgeUnitRoutes)
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_KEY
    process.env.SUPABASE_URL = 'https://storage.example.test'
    process.env.SUPABASE_SERVICE_KEY = 'secret-test-only'
    const calls = []
    const boundary = 'knowledge-test-boundary'
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n')
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Guia.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push({ url, method: options.method })
      return options.method === 'POST' ? { ok: false, status: 500 } : { ok: true, status: 200 }
    }))
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/knowledge/unit/materials/${MATERIAL}/attachments`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody,
      })
      expect(response.statusCode).toBe(502)
      expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
      expect(query.mock.calls.some(([sql]) => sql.includes("state = 'orphaned'"))).toBe(true)
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY
      else process.env.SUPABASE_SERVICE_KEY = previousKey
      await app.close()
    }
  })

  it('uses the database winner for concurrent idempotent creation', async () => {
    const { app, query, queries } = buildApp({ queryResults: [{ rows: [{ id: MATERIAL, inserted: false, titulo: 'Vencedor' }] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', headers: { 'idempotency-key': 'same-request' }, payload: { titulo: 'Tentativa repetida', content_markdown: 'texto' } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: MATERIAL, titulo: 'Vencedor' })
    expect(queries[0].sql).toMatch(/ON CONFLICT \(tenant_id, idempotency_key\) DO UPDATE/)
    await app.close()
  })

  it('validates publication inside a transaction and returns the existing revision conflict', async () => {
    const { app, query } = buildApp({ queryResults: [
      { rows: [] },
      { rows: [{ id: MATERIAL, revision: 1, content_markdown: null, external_url: null, video_id: null, has_ready_attachment: false }] },
      { rows: [] },
    ] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'POST', url: `/v1/knowledge/unit/materials/${MATERIAL}/publish`, payload: { expected_revision: 1 } })
    expect(response.statusCode).toBe(400)
    expect(query.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(true)
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
    await app.close()
  })

  it('returns an absolute signed URL and preserves the original download name', async () => {
    const { app } = buildApp({ queryResults: [{ rows: [{ id: 'att-1', storage_key: `${TENANT}/opaque.pdf`, original_name: 'Guia operação.pdf', mime_type: 'application/pdf', byte_size: 123 }] }] })
    await app.register(knowledgeUnitRoutes)
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_KEY
    process.env.SUPABASE_URL = 'https://storage.example.test'
    process.env.SUPABASE_SERVICE_KEY = 'secret-test-only'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ signedURL: '/storage/v1/object/sign/knowledge-private/opaque.pdf?token=x' }) }))
    try {
      const response = await app.inject({ method: 'GET', url: `/v1/knowledge/unit/materials/${MATERIAL}/attachments/att-1` })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ url: 'https://storage.example.test/storage/v1/object/sign/knowledge-private/opaque.pdf?token=x', filename: 'Guia operação.pdf' })
      expect(response.json().content_disposition).toContain('filename*=UTF-8')
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY
      else process.env.SUPABASE_SERVICE_KEY = previousKey
      await app.close()
    }
  })

  it('does not return a material from another tenant even when its id is known', async () => {
    const { app, query } = buildApp({ tenant: OTHER_TENANT, queryResults: [{ rows: [] }] })
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'GET', url: `/v1/knowledge/unit/materials/${MATERIAL}` })
    expect(response.statusCode).toBe(404)
    expect(query.mock.calls[0][1]).toContain(OTHER_TENANT)
    await app.close()
  })

  it('rejects create with published status before inserting', async () => {
    const { app, query } = buildApp()
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/unit/materials',
      headers: IDEMPOTENCY_HEADER,
      payload: { titulo: 'Publicado direto', status: 'published', content_markdown: 'texto' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Use a ação publicar.' })
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('requires Idempotency-Key on create', async () => {
    const { app, query } = buildApp()
    await app.register(knowledgeUnitRoutes)
    const response = await app.inject({ method: 'POST', url: '/v1/knowledge/unit/materials', payload: { titulo: 'Sem chave', content_markdown: 'texto' } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/Idempotency-Key/)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects inactive or foreign categories on create and patch', async () => {
    const category = '55555555-5555-4555-8555-555555555555'
    const { app, query } = buildApp({ queryResults: [
      { rows: [] },
      { rows: [{ is_active: false }] },
      { rows: [{ is_active: false }] },
    ] })
    await app.register(knowledgeUnitRoutes)

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/unit/materials',
      headers: { 'idempotency-key': 'cat-missing' },
      payload: { titulo: 'Com categoria', category_id: category },
    })
    const inactive = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/unit/materials',
      headers: { 'idempotency-key': 'cat-inactive' },
      payload: { titulo: 'Com categoria inativa', category_id: category },
    })
    const patchInactive = await app.inject({
      method: 'PATCH',
      url: `/v1/knowledge/unit/materials/${MATERIAL}`,
      payload: { category_id: category, expected_revision: 1 },
    })

    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toBe('Categoria inválida')
    expect(inactive.statusCode).toBe(400)
    expect(inactive.json().error).toBe('Categoria inativa')
    expect(patchInactive.statusCode).toBe(400)
    expect(patchInactive.json().error).toBe('Categoria inativa')
    expect(query).toHaveBeenCalledTimes(3)
    await app.close()
  })

  it('rejects unsafe legacy network article writes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'article-1' }] })
    const { app } = buildLegacyKnowledgeApp({ query })
    await app.register(knowledgeRoutes)

    const html = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/articles',
      payload: { titulo: 'Ataque', content_markdown: '<script>alert(1)</script>' },
    })
    const video = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/articles',
      payload: { titulo: 'Vídeo', video_provider: 'youtube', video_url: 'https://evil.example/watch?v=abc' },
    })
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/articles',
      payload: { titulo: 'OK', content_markdown: 'texto seguro' },
    })

    expect(html.statusCode).toBe(400)
    expect(video.statusCode).toBe(400)
    expect(ok.statusCode).toBe(201)
    expect(query).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
