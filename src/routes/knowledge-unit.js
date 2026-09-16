import crypto from 'node:crypto'
import { z } from 'zod'
import { KNOWLEDGE_PRIVATE_BUCKET } from '../services/knowledge-storage.js'

// Local Base API. `manuais`/`knowledge_categories` remain global legacy data;
// this plugin keeps new content tenant-scoped until every legacy reader has
// been migrated. Clients, partners and automation are deliberately excluded.
const READERS = [
  'franqueador_master', 'franqueado', 'gerente', 'gerente_comercial',
  'financeiro', 'financeiro_readonly', 'auditor', 'suporte', 'operacional',
  'produtor_live', 'marketing', 'comercial_readonly', 'apresentador', 'apresentadora',
]
const MANAGERS = ['franqueador_master', 'franqueado', 'gerente', 'gerente_comercial']
const PDF_MAX_BYTES = 10 * 1024 * 1024
const PRIVATE_BUCKET = KNOWLEDGE_PRIVATE_BUCKET

const uuid = z.string().uuid()
const slugify = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const isPdf = (buffer) => {
  if (!/^%PDF-[0-9]\.[0-9]/.test(buffer.subarray(0, 8).toString('ascii'))) return false
  const tail = buffer.subarray(Math.max(0, buffer.length - 1024 * 1024)).toString('latin1')
  return /%%EOF\s*$/.test(tail)
}

const categorySchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
})
const categoryPatchSchema = categorySchema.partial().extend({ is_active: z.boolean().optional() })

const contentFields = {
  category_id: uuid.nullable().optional(),
  titulo: z.string().trim().min(2).max(240).optional(),
  excerpt: z.string().max(500).nullable().optional(),
  content_markdown: z.string().max(50000).nullable().optional(),
  material_type: z.enum(['playbook', 'study', 'video', 'document', 'link']).optional(),
  external_url: z.string().url().nullable().optional(),
  video_provider: z.enum(['youtube', 'panda', 'none']).optional(),
  video_url: z.string().url().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
}
const createSchema = z.object({
  ...contentFields,
  titulo: z.string().trim().min(2).max(240),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
})
// A material can only become published through the transactional publish route.
// Keeping that transition out of PATCH prevents bypassing the content/PDF gate.
const patchSchema = z.object({ ...contentFields, status: z.enum(['draft', 'archived']).optional(), expected_revision: z.number().int().positive() })

function unsafeMarkdown(markdown) {
  return markdown && (/<\/?(?:script|iframe|object|embed|form|style|link)\b/i.test(markdown)
    || /\bon[a-z]+\s*=\s*['"]?/i.test(markdown)
    || /(?:javascript|data|vbscript):/i.test(markdown))
}

function safeUrl(value, kind = 'link') {
  if (!value) return true
  let parsed
  try { parsed = new URL(value) } catch { return false }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false
  if (kind !== 'video') return true
  const host = parsed.hostname.toLowerCase()
  return ['youtube.com', 'www.youtube.com', 'youtu.be', 'panda.video'].includes(host) || host.endsWith('.pandavideo.com')
}

function videoInputError(data) {
  const provider = data.video_provider ?? 'none'
  if (provider !== 'none' && !data.video_url) return 'URL de vídeo obrigatória'
  if (provider === 'none' && data.video_url) return 'Informe o provedor do vídeo'
  if (provider !== 'none' && data.video_url) {
    let host
    try { host = new URL(data.video_url).hostname.toLowerCase() } catch { return 'URL de vídeo inválida' }
    const youtube = ['youtube.com', 'www.youtube.com', 'youtu.be'].includes(host)
    const panda = host === 'panda.video' || host.endsWith('.pandavideo.com')
    if ((provider === 'youtube' && !youtube) || (provider === 'panda' && !panda)) return 'O provedor não corresponde à URL do vídeo'
    const id = videoId(data.video_url, provider)
    if (!id || !SAFE_VIDEO_ID.test(id)) return 'URL de vídeo sem identificador válido'
  }
  return null
}

function videoPatchError(data) {
  const hasProvider = Object.prototype.hasOwnProperty.call(data, 'video_provider')
  const hasUrl = Object.prototype.hasOwnProperty.call(data, 'video_url')
  if (!hasProvider && !hasUrl) return null
  // `none` without a URL is the explicit and safe way to clear a video.
  if (hasProvider && data.video_provider === 'none' && !hasUrl) return null
  if (!hasProvider || !hasUrl) return 'Informe provedor e URL do vídeo juntos'
  return videoInputError(data)
}

function videoId(value, provider) {
  if (!value || provider === 'none') return null
  const parsed = new URL(value)
  if (provider === 'youtube') return parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1).split('/')[0] : (parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).at(-1))
  return parsed.pathname.split('/').filter(Boolean).at(-1) || null
}

function hasUsableContent(data) {
  return Boolean(data.content_markdown?.trim() || data.external_url || data.video_url || data.video_id)
}

const SAFE_VIDEO_ID = /^[A-Za-z0-9_-]{1,200}$/
function canonicalVideoUrl(provider, id) {
  if (!id || !SAFE_VIDEO_ID.test(String(id))) return null
  if (provider === 'youtube') return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
  if (provider === 'panda') return `https://panda.video/${encodeURIComponent(id)}`
  return null
}

function materialResponse(row) {
  if (!row) return row
  return { ...row, video_url: canonicalVideoUrl(row.video_provider, row.video_id) }
}

function attachmentResponse(row) {
  if (!row) return row
  const { storage_key: _storageKey, ...safe } = row
  return { ...safe, filename: safe.filename ?? safe.original_name }
}

function audit(app, request, action, entityType, entityId, metadata = {}) {
  return app.audit?.log?.(request, {
    action,
    entity_type: entityType,
    entity_id: entityId ?? null,
    metadata: {
      tenant_id: request.user?.tenant_id ?? null,
      actor_id: request.user?.sub ?? null,
      ...metadata,
    },
  })?.catch((error) => request.log?.warn?.({ error }, 'knowledge audit failed'))
}

function fileName(value) {
  return (String(value ?? 'arquivo.pdf').replace(/[\\/\0\r\n]/g, '_').trim().slice(0, 255) || 'arquivo.pdf')
}

async function readPdfPart(part) {
  if (!part) { const error = new Error('Nenhum arquivo enviado'); error.statusCode = 400; throw error }
  if (part.mimetype !== 'application/pdf') { const error = new Error('Somente PDF é aceito'); error.statusCode = 400; throw error }
  const chunks = []; let bytes = 0
  for await (const chunk of part.file) {
    bytes += chunk.length
    if (bytes > PDF_MAX_BYTES) { const error = new Error('PDF muito grande. Máximo 10 MB.'); error.statusCode = 413; throw error }
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  if (!isPdf(buffer)) { const error = new Error('O conteúdo não é um PDF válido'); error.statusCode = 400; throw error }
  return { buffer, originalName: fileName(part.filename) }
}

async function storage(app, request, method, path, body, extraHeaders = {}) {
  const base = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!base || !key) { const error = new Error('Armazenamento privado não configurado'); error.statusCode = 503; throw error }
  const response = await fetch(`${base}/storage/v1${path}`, { method, body, headers: { Authorization: `Bearer ${key}`, ...extraHeaders } })
  if (!response.ok) {
    request.log.error({ status: response.status }, 'knowledge private storage failed')
    const error = new Error('Falha no armazenamento privado'); error.statusCode = response.status === 413 ? 413 : 502; throw error
  }
  return response
}

function absoluteStorageUrl(raw) {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, '')
  if (!base || !raw) return raw
  return raw.startsWith('http://') || raw.startsWith('https://') ? raw : `${base}${raw.startsWith('/') ? '' : '/'}${raw}`
}

function page(query) {
  const current = Math.max(1, Number.parseInt(query?.page ?? '1', 10) || 1)
  const size = Math.min(100, Math.max(1, Number.parseInt(query?.page_size ?? '24', 10) || 24))
  return { current, size, offset: (current - 1) * size }
}

export async function knowledgeUnitRoutes(app) {
  const readers = [app.authenticate, app.requirePapel(READERS)]
  const managers = [app.authenticate, app.requirePapel(MANAGERS)]

  app.get('/v1/knowledge/unit/categories', { onRequest: readers }, async (request) => app.withTenant(request.user.tenant_id, async (db) => {
    const includeInactive = request.query?.include_inactive === 'true' && MANAGERS.includes(request.user.papel)
    const result = await db.query(`SELECT id, name, slug, description, icon, sort_order, is_active, created_at, updated_at FROM knowledge_unit_categories WHERE tenant_id = $1${includeInactive ? '' : ' AND is_active = true'} ORDER BY sort_order, name`, [request.user.tenant_id])
    return result.rows
  }))

  app.post('/v1/knowledge/unit/categories', { onRequest: managers }, async (request, reply) => {
    const parsed = categorySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const data = parsed.data
    return app.withTenant(request.user.tenant_id, async (db) => {
      try {
        const result = await db.query(`INSERT INTO knowledge_unit_categories (tenant_id, name, slug, description, icon, sort_order, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [request.user.tenant_id, data.name, slugify(data.name), data.description ?? null, data.icon ?? null, data.sort_order ?? 0, request.user.sub])
        const row = result.rows[0]
        await audit(app, request, 'knowledge.category.create', 'knowledge_category', row.id, { revision: 1 })
        return reply.code(201).send(row)
      } catch (error) { if (error.code === '23505') return reply.code(409).send({ error: 'Já existe categoria com esse slug nesta unidade' }); throw error }
    })
  })

  app.patch('/v1/knowledge/unit/categories/:id', { onRequest: managers }, async (request, reply) => {
    const parsed = categoryPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const values = []; const fields = []
    for (const key of ['name', 'description', 'icon', 'sort_order', 'is_active']) if (parsed.data[key] !== undefined) { fields.push(`${key} = $${values.length + 1}`); values.push(parsed.data[key]) }
    if (parsed.data.name !== undefined) { fields.push(`slug = $${values.length + 1}`); values.push(slugify(parsed.data.name)) }
    if (!fields.length) return reply.code(400).send({ error: 'Nada para atualizar' })
    fields.push(`updated_by = $${values.length + 1}`, 'updated_at = NOW()'); values.push(request.user.sub)
    values.push(request.params.id, request.user.tenant_id)
    return app.withTenant(request.user.tenant_id, async (db) => {
      const result = await db.query(`UPDATE knowledge_unit_categories SET ${fields.join(', ')} WHERE id = $${values.length - 1} AND tenant_id = $${values.length} RETURNING *`, values)
      if (!result.rows.length) return reply.code(404).send({ error: 'Categoria não encontrada' })
      await audit(app, request, 'knowledge.category.update', 'knowledge_category', result.rows[0].id, { revision: null, changed_fields: Object.keys(parsed.data) })
      return result.rows[0]
    })
  })

  app.post('/v1/knowledge/unit/categories/reorder', { onRequest: managers }, async (request, reply) => {
    const parsed = z.object({ ids: z.array(uuid).min(1).max(500) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    return app.withTenant(request.user.tenant_id, async (db) => {
      for (let i = 0; i < parsed.data.ids.length; i++) await db.query('UPDATE knowledge_unit_categories SET sort_order = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3 AND tenant_id = $4', [i + 1, request.user.sub, parsed.data.ids[i], request.user.tenant_id])
      await audit(app, request, 'knowledge.category.reorder', 'knowledge_category', null, { count: parsed.data.ids.length })
      return reply.code(204).send()
    })
  })

  app.delete('/v1/knowledge/unit/categories/:id', { onRequest: managers }, async (request, reply) => app.withTenant(request.user.tenant_id, async (db) => {
    const result = await db.query('UPDATE knowledge_unit_categories SET is_active = false, updated_at = NOW(), updated_by = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id', [request.user.sub, request.params.id, request.user.tenant_id])
    if (!result.rows.length) return reply.code(404).send({ error: 'Categoria não encontrada' })
    await audit(app, request, 'knowledge.category.archive', 'knowledge_category', result.rows[0].id, { revision: null })
    return reply.code(204).send()
  }))

  app.get('/v1/knowledge/unit/materials', { onRequest: readers }, async (request) => {
    const { current, size, offset } = page(request.query)
    const values = [request.user.tenant_id]; const predicates = ['m.tenant_id = $1']
    const manager = MANAGERS.includes(request.user.papel)
    if (manager && request.query?.status) { predicates.push(`m.status = $${values.length + 1}`); values.push(request.query.status) } else predicates.push("m.status = 'published'")
    if (request.query?.q) { predicates.push(`(m.title ILIKE $${values.length + 1} OR m.excerpt ILIKE $${values.length + 1} OR EXISTS (SELECT 1 FROM unnest(m.tags) t WHERE t ILIKE $${values.length + 1}))`); values.push(`%${String(request.query.q).trim()}%`) }
    if (request.query?.material_type) { predicates.push(`m.material_type = $${values.length + 1}`); values.push(request.query.material_type) }
    if (request.query?.category_slug) { predicates.push(`c.slug = $${values.length + 1}`); values.push(request.query.category_slug) }
    const limitIndex = values.length + 1; values.push(size); const offsetIndex = values.length + 1; values.push(offset)
    return app.withTenant(request.user.tenant_id, async (db) => {
      const result = await db.query(`SELECT m.id, m.title AS titulo, m.slug, m.excerpt, m.material_type, m.external_url, m.video_provider, m.video_id, m.tags, m.status, m.revision, m.published_at, m.updated_at AS atualizado_em, m.category_id, c.name AS category_name, c.slug AS category_slug, (SELECT COUNT(*)::int FROM knowledge_material_attachments a WHERE a.material_id = m.id AND a.tenant_id = m.tenant_id AND a.state = 'ready') AS attachment_count FROM knowledge_materials m LEFT JOIN knowledge_unit_categories c ON c.id = m.category_id AND c.tenant_id = m.tenant_id WHERE ${predicates.join(' AND ')} ORDER BY m.updated_at DESC, m.id LIMIT $${limitIndex} OFFSET $${offsetIndex}`, values)
      return { items: result.rows.map(materialResponse), page: current, page_size: size, has_more: result.rows.length === size }
    })
  })

  app.get('/v1/knowledge/unit/search', { onRequest: readers }, async (request, reply) => {
    if (String(request.query?.q ?? '').trim().length < 2) return { items: [], page: 1, page_size: 24, has_more: false }
    return app.inject({ method: 'GET', url: `/v1/knowledge/unit/materials?q=${encodeURIComponent(request.query.q)}`, headers: { authorization: request.headers.authorization } }).then((response) => response.json()).catch(() => reply.code(500).send({ error: 'Falha na busca' }))
  })

  app.get('/v1/knowledge/unit/materials/:slugOrId', { onRequest: readers }, async (request, reply) => app.withTenant(request.user.tenant_id, async (db) => {
    const key = request.params.slugOrId; const manager = MANAGERS.includes(request.user.papel)
    const result = await db.query(`SELECT m.*, m.title AS titulo, m.updated_at AS atualizado_em, c.name AS category_name, c.slug AS category_slug FROM knowledge_materials m LEFT JOIN knowledge_unit_categories c ON c.id = m.category_id AND c.tenant_id = m.tenant_id WHERE m.tenant_id = $1 AND ${isUuid(key) ? 'm.id = $2' : 'm.slug = $2'} AND ($3 OR m.status = 'published')`, [request.user.tenant_id, key, manager])
    if (!result.rows.length) return reply.code(404).send({ error: 'Material não encontrado' })
    const material = result.rows[0]
    const attachments = await db.query(`SELECT id, original_name, mime_type, byte_size, state, created_at FROM knowledge_material_attachments WHERE tenant_id = $1 AND material_id = $2 AND ($3 OR state = 'ready') ORDER BY created_at DESC`, [request.user.tenant_id, material.id, manager])
    material.video_url = canonicalVideoUrl(material.video_provider, material.video_id)
    material.attachments = attachments.rows.map(attachmentResponse)
    return material
  }))

  app.post('/v1/knowledge/unit/materials', { onRequest: managers }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const data = parsed.data
    if (data.status === 'published' && !hasUsableContent(data)) return reply.code(400).send({ error: 'Publique somente após informar texto, link, vídeo ou PDF' })
    const videoError = videoInputError(data)
    if (videoError) return reply.code(400).send({ error: videoError })
    if (unsafeMarkdown(data.content_markdown)) return reply.code(400).send({ error: 'O conteúdo contém HTML ou URL não permitido' })
    if (!safeUrl(data.external_url) || !safeUrl(data.video_url, 'video')) return reply.code(400).send({ error: 'URL externa não permitida' })
    const idempotency = String(request.headers['idempotency-key'] ?? '').trim().slice(0, 200) || null
    return app.withTenant(request.user.tenant_id, async (db) => {
      try {
        const result = await db.query(`
          INSERT INTO knowledge_materials
            (tenant_id, category_id, title, slug, excerpt, content_markdown, material_type,
             external_url, video_provider, video_id, tags, status, idempotency_key,
             created_by, updated_by, published_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,CASE WHEN $12 = 'published' THEN NOW() END)
          ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
            SET updated_at = knowledge_materials.updated_at
          RETURNING *, title AS titulo, updated_at AS atualizado_em, (xmax = 0) AS inserted`,
          [request.user.tenant_id, data.category_id ?? null, data.titulo, `${slugify(data.titulo)}-${crypto.randomBytes(4).toString('hex')}`, data.excerpt ?? null, data.content_markdown ?? null, data.material_type ?? 'playbook', data.external_url ?? null, data.video_provider ?? 'none', videoId(data.video_url, data.video_provider ?? 'none'), data.tags ?? [], data.status, idempotency, request.user.sub])
        const row = materialResponse(result.rows[0])
        if (row.inserted !== false) await audit(app, request, 'knowledge.material.create', 'knowledge_material', row.id, { revision: row.revision ?? 1, status: row.status ?? data.status })
        return reply.code(row.inserted === false ? 200 : 201).send(row)
      } catch (error) { if (error.code === '23505') return reply.code(409).send({ error: 'Material ou chave de idempotência já existe' }); throw error }
    })
  })

  app.patch('/v1/knowledge/unit/materials/:id', { onRequest: managers }, async (request, reply) => {
    const parsed = patchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const data = parsed.data
    const videoError = videoPatchError(data)
    if (videoError) return reply.code(400).send({ error: videoError })
    if (data.content_markdown === null && data.external_url === null && data.video_url === null) return reply.code(400).send({ error: 'O material precisa manter texto, link ou vídeo' })
    if (unsafeMarkdown(data.content_markdown)) return reply.code(400).send({ error: 'O conteúdo contém HTML ou URL não permitido' })
    if (!safeUrl(data.external_url) || !safeUrl(data.video_url, 'video')) return reply.code(400).send({ error: 'URL externa não permitida' })
    const values = []; const fields = []
    const columns = { category_id: 'category_id', titulo: 'title', excerpt: 'excerpt', content_markdown: 'content_markdown', material_type: 'material_type', external_url: 'external_url', video_provider: 'video_provider', tags: 'tags', status: 'status' }
    for (const [key, column] of Object.entries(columns)) if (data[key] !== undefined) { fields.push(`${column} = $${values.length + 1}`); values.push(data[key]) }
    if (Object.prototype.hasOwnProperty.call(data, 'video_provider') || Object.prototype.hasOwnProperty.call(data, 'video_url')) {
      fields.push(`video_id = $${values.length + 1}`)
      values.push(videoId(data.video_url, data.video_provider ?? 'none'))
    }
    if (data.titulo !== undefined) { fields.push(`slug = $${values.length + 1}`); values.push(`${slugify(data.titulo)}-${request.params.id.slice(0, 8)}`) }
    if (!fields.length) return reply.code(400).send({ error: 'Nada para atualizar' })
    fields.push('revision = revision + 1', 'updated_at = NOW()', `updated_by = $${values.length + 1}`); values.push(request.user.sub, request.params.id, data.expected_revision, request.user.tenant_id)
    return app.withTenant(request.user.tenant_id, async (db) => {
      const result = await db.query(`UPDATE knowledge_materials SET ${fields.join(', ')} WHERE id = $${values.length - 2} AND tenant_id = $${values.length} AND revision = $${values.length - 1} RETURNING *`, values)
      if (result.rows.length) {
        const row = materialResponse(result.rows[0])
        await audit(app, request, 'knowledge.material.update', 'knowledge_material', row.id, { revision: row.revision, changed_fields: Object.keys(data).filter((key) => key !== 'expected_revision') })
        return row
      }
      const current = await db.query('SELECT id, revision FROM knowledge_materials WHERE id = $1 AND tenant_id = $2', [request.params.id, request.user.tenant_id])
      if (!current.rows.length) return reply.code(404).send({ error: 'Material não encontrado' })
      return reply.code(409).send({ error: 'Material foi alterado em outra aba', current_revision: current.rows[0].revision })
    })
  })

  for (const [action, status] of [['publish', 'published'], ['archive', 'archived']]) {
    app.post(`/v1/knowledge/unit/materials/:id/${action}`, { onRequest: managers }, async (request, reply) => {
      const expected = Number(request.body?.expected_revision)
      if (!Number.isInteger(expected) || expected < 1) return reply.code(400).send({ error: 'expected_revision obrigatório' })
      return app.withTenant(request.user.tenant_id, async (db) => {
        await db.query('BEGIN')
        try {
          const current = await db.query(`
            SELECT m.id, m.slug, m.status, m.revision, m.content_markdown, m.external_url,
                   m.video_provider, m.video_id, EXISTS (
                     SELECT 1 FROM knowledge_material_attachments a
                      WHERE a.material_id = m.id AND a.tenant_id = m.tenant_id AND a.state = 'ready'
                   ) AS has_ready_attachment
              FROM knowledge_materials m
             WHERE m.id = $1 AND m.tenant_id = $2
             FOR UPDATE`, [request.params.id, request.user.tenant_id])
          if (!current.rows.length) { await db.query('ROLLBACK'); return reply.code(404).send({ error: 'Material não encontrado' }) }
          const material = current.rows[0]
          if (material.revision !== expected) {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Material foi alterado em outra aba', current_revision: material.revision })
          }
          if (status === 'published' && !hasUsableContent(material) && !material.has_ready_attachment) {
            await db.query('ROLLBACK')
            return reply.code(400).send({ error: 'Publique somente após informar texto, link, vídeo ou anexar um PDF pronto' })
          }
          const result = await db.query(`
            UPDATE knowledge_materials
               SET status = $1, revision = revision + 1,
                   published_at = CASE WHEN $1 = 'published' THEN COALESCE(published_at, NOW()) ELSE published_at END,
                   updated_at = NOW(), updated_by = $2
             WHERE id = $3 AND tenant_id = $4 AND revision = $5
           RETURNING id, slug, status, revision, published_at, video_provider, video_id`, [status, request.user.sub, request.params.id, request.user.tenant_id, expected])
          await db.query('COMMIT')
          const row = materialResponse(result.rows[0])
          await audit(app, request, `knowledge.material.${action}`, 'knowledge_material', row.id, { revision: row.revision, status: row.status })
          return row
        } catch (error) {
          await db.query('ROLLBACK').catch(() => {})
          throw error
        }
      })
    })
  }

  app.post('/v1/knowledge/unit/materials/:id/attachments', { onRequest: managers }, async (request, reply) => {
    const material = await app.withTenant(request.user.tenant_id, (db) => db.query('SELECT id FROM knowledge_materials WHERE id = $1 AND tenant_id = $2', [request.params.id, request.user.tenant_id]))
    if (!material.rows.length) return reply.code(404).send({ error: 'Material não encontrado' })
    let part
    try { part = await request.file({ limits: { fileSize: PDF_MAX_BYTES } }) } catch (error) { if (error.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'PDF muito grande. Máximo 10 MB.' }); throw error }
    let pdf
    try { pdf = await readPdfPart(part) } catch (error) { return reply.code(error.statusCode ?? 400).send({ error: error.message }) }
    const { buffer, originalName } = pdf
    const storageKey = `${request.user.tenant_id}/${crypto.randomUUID()}.pdf`
    const attachment = await app.withTenant(request.user.tenant_id, (db) => db.query(`INSERT INTO knowledge_material_attachments (tenant_id, material_id, storage_key, original_name, mime_type, byte_size, state, created_by) VALUES ($1,$2,$3,$4,'application/pdf',$5,'pending',$6) RETURNING *`, [request.user.tenant_id, request.params.id, storageKey, originalName, buffer.length, request.user.sub]).then((result) => result.rows[0]))
    try {
      await storage(app, request, 'POST', `/object/${PRIVATE_BUCKET}/${storageKey}`, buffer, { 'Content-Type': 'application/pdf', 'x-upsert': 'false' })
      return app.withTenant(request.user.tenant_id, async (db) => {
        const result = await db.query(`UPDATE knowledge_material_attachments SET state = 'ready', ready_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`, [attachment.id, request.user.tenant_id])
        if (!result.rows.length) return reply.code(409).send({ error: 'O anexo não está mais disponível' })
        const row = attachmentResponse(result.rows[0])
        await audit(app, request, 'knowledge.attachment.create', 'knowledge_attachment', row.id, { state: row.state, byte_size: row.byte_size, revision: null })
        return reply.code(201).send(row)
      })
    } catch (error) {
      await storage(app, request, 'DELETE', `/object/${PRIVATE_BUCKET}/${storageKey}`).catch(() => {})
      await app.withTenant(request.user.tenant_id, (db) => db.query(`UPDATE knowledge_material_attachments SET state = 'orphaned', orphaned_at = NOW() WHERE id = $1 AND tenant_id = $2`, [attachment.id, request.user.tenant_id])).catch(() => {})
      await audit(app, request, 'knowledge.attachment.orphaned', 'knowledge_attachment', attachment.id, { state: 'orphaned' })
      throw error
    }
  })

  app.post('/v1/knowledge/unit/materials/:id/attachments/:attachmentId/retry', { onRequest: managers }, async (request, reply) => {
    const existing = await app.withTenant(request.user.tenant_id, (db) => db.query(`SELECT a.id FROM knowledge_material_attachments a WHERE a.id = $1 AND a.material_id = $2 AND a.tenant_id = $3 AND a.state = 'orphaned'`, [request.params.attachmentId, request.params.id, request.user.tenant_id]))
    if (!existing.rows.length) return reply.code(404).send({ error: 'Anexo órfão não encontrado' })
    let part
    try { part = await request.file({ limits: { fileSize: PDF_MAX_BYTES } }) } catch (error) { if (error.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'PDF muito grande. Máximo 10 MB.' }); throw error }
    let pdf
    try { pdf = await readPdfPart(part) } catch (error) { return reply.code(error.statusCode ?? 400).send({ error: error.message }) }
    const { buffer, originalName } = pdf
    const storageKey = `${request.user.tenant_id}/${crypto.randomUUID()}.pdf`
    const moved = await app.withTenant(request.user.tenant_id, (db) => db.query(`UPDATE knowledge_material_attachments SET storage_key = $1, original_name = $2, byte_size = $3, state = 'pending', orphaned_at = NULL WHERE id = $4 AND tenant_id = $5 AND state = 'orphaned' RETURNING *`, [storageKey, originalName, buffer.length, request.params.attachmentId, request.user.tenant_id]))
    if (!moved.rows.length) return reply.code(409).send({ error: 'O anexo já está sendo processado' })
    try {
      await storage(app, request, 'POST', `/object/${PRIVATE_BUCKET}/${storageKey}`, buffer, { 'Content-Type': 'application/pdf', 'x-upsert': 'false' })
      return app.withTenant(request.user.tenant_id, async (db) => {
        const result = await db.query(`UPDATE knowledge_material_attachments SET state = 'ready', ready_at = NOW() WHERE id = $1 AND tenant_id = $2 AND state = 'pending' RETURNING *`, [request.params.attachmentId, request.user.tenant_id])
        if (!result.rows.length) return reply.code(409).send({ error: 'O anexo não está mais disponível' })
        const row = attachmentResponse(result.rows[0])
        await audit(app, request, 'knowledge.attachment.retry', 'knowledge_attachment', row.id, { state: row.state, byte_size: row.byte_size, revision: null })
        return reply.code(200).send(row)
      })
    } catch (error) {
      await storage(app, request, 'DELETE', `/object/${PRIVATE_BUCKET}/${storageKey}`).catch(() => {})
      await app.withTenant(request.user.tenant_id, (db) => db.query(`UPDATE knowledge_material_attachments SET state = 'orphaned', orphaned_at = NOW() WHERE id = $1 AND tenant_id = $2`, [request.params.attachmentId, request.user.tenant_id])).catch(() => {})
      await audit(app, request, 'knowledge.attachment.orphaned', 'knowledge_attachment', request.params.attachmentId, { state: 'orphaned' })
      throw error
    }
  })

  app.get('/v1/knowledge/unit/materials/:id/attachments/:attachmentId', { onRequest: readers }, async (request, reply) => {
    const canManage = MANAGERS.includes(request.user.papel)
    const result = await app.withTenant(request.user.tenant_id, (db) => db.query(`SELECT a.id, a.storage_key, a.original_name, a.mime_type, a.byte_size FROM knowledge_material_attachments a JOIN knowledge_materials m ON m.id = a.material_id AND m.tenant_id = a.tenant_id WHERE a.id = $1 AND a.material_id = $2 AND a.tenant_id = $3 AND a.state = 'ready' AND ($4 OR m.status = 'published')`, [request.params.attachmentId, request.params.id, request.user.tenant_id, canManage]))
    if (!result.rows.length) return reply.code(404).send({ error: 'Anexo não encontrado' })
    const row = result.rows[0]
    const expires = Math.min(3600, Math.max(60, Number.parseInt(request.query?.expires_in ?? '600', 10) || 600))
    const signed = await storage(app, request, 'POST', `/object/sign/${PRIVATE_BUCKET}/${row.storage_key}`, JSON.stringify({ expiresIn: expires }), { 'Content-Type': 'application/json' })
    const body = await signed.json()
    return {
      id: row.id,
      filename: row.original_name,
      mime_type: row.mime_type,
      byte_size: row.byte_size,
      content_disposition: `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
      url: absoluteStorageUrl(body.signedURL ?? body.signedUrl ?? body.url),
      expires_in: expires,
    }
  })

  app.get('/v1/knowledge/unit/materials/:id/attachments/:attachmentId/download', { onRequest: readers }, async (request, reply) => {
    const canManage = MANAGERS.includes(request.user.papel)
    const result = await app.withTenant(request.user.tenant_id, (db) => db.query(`SELECT a.id, a.storage_key, a.original_name, a.mime_type, a.byte_size FROM knowledge_material_attachments a JOIN knowledge_materials m ON m.id = a.material_id AND m.tenant_id = a.tenant_id WHERE a.id = $1 AND a.material_id = $2 AND a.tenant_id = $3 AND a.state = 'ready' AND ($4 OR m.status = 'published')`, [request.params.attachmentId, request.params.id, request.user.tenant_id, canManage]))
    if (!result.rows.length) return reply.code(404).send({ error: 'Anexo não encontrado' })
    const row = result.rows[0]
    const signed = await storage(app, request, 'POST', `/object/sign/${PRIVATE_BUCKET}/${row.storage_key}`, JSON.stringify({ expiresIn: 600 }), { 'Content-Type': 'application/json' })
    const signedBody = await signed.json()
    const response = await fetch(absoluteStorageUrl(signedBody.signedURL ?? signedBody.signedUrl ?? signedBody.url))
    if (!response.ok) return reply.code(502).send({ error: 'Não foi possível baixar o anexo' })
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > PDF_MAX_BYTES || !isPdf(body)) return reply.code(502).send({ error: 'O armazenamento retornou um PDF inválido' })
    reply.header('Content-Type', row.mime_type)
    reply.header('Content-Length', String(body.length))
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`)
    return reply.send(body)
  })
}
