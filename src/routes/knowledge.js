import { z } from 'zod'

/**
 * Knowledge Base — categorias + artigos com Markdown + vídeo embedado.
 * Evolução do módulo `manuais` (compat mantida).
 *
 * Categorias:
 *   GET    /v1/knowledge/categories
 *   POST   /v1/knowledge/categories               (master)
 *   PATCH  /v1/knowledge/categories/:id           (master)
 *   DELETE /v1/knowledge/categories/:id           (master, soft via is_active=false)
 *
 * Artigos (tabela `manuais` expandida):
 *   GET    /v1/knowledge/articles                 (filter: category_slug, status, q)
 *   GET    /v1/knowledge/articles/:slug
 *   POST   /v1/knowledge/articles                 (master)
 *   PATCH  /v1/knowledge/articles/:id             (master)
 *   POST   /v1/knowledge/articles/:id/publish     (master)
 *   POST   /v1/knowledge/articles/:id/archive     (master)
 *   DELETE /v1/knowledge/articles/:id             (master)
 *   GET    /v1/knowledge/search?q=                busca em titulo/excerpt/tags
 */

const slugify = (str) =>
  str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const calcReadMinutes = (markdown) => {
  if (!markdown) return null
  const words = markdown.trim().split(/\s+/).length
  return Math.max(1, Math.round(words / 200))
}

const categorySchema = z.object({
  name:        z.string().min(2, 'Nome obrigatório').max(120),
  description: z.string().max(500).optional(),
  icon:        z.string().max(40).optional(),
  sort_order:  z.number().int().optional(),
  is_active:   z.boolean().optional(),
})

const articleSchema = z.object({
  category_id:      z.string().uuid().nullable().optional(),
  titulo:           z.string().min(2, 'Título obrigatório').max(240),
  excerpt:          z.string().max(500).optional(),
  content_markdown: z.string().max(50000).optional(),
  url:              z.string().url('URL inválida').optional(),
  cover_image_url:  z.string().url().optional(),
  video_provider:   z.enum(['youtube', 'panda', 'none']).optional().default('none'),
  video_url:        z.string().url('URL de vídeo inválida').optional(),
  tags:             z.array(z.string().max(40)).max(20).optional(),
  status:           z.enum(['draft', 'published', 'archived']).optional().default('draft'),
  sort_order:       z.number().int().optional(),
  categoria:        z.string().max(80).optional(), // legacy compat
  paginas:          z.number().int().positive().optional(),
  destaque:         z.boolean().optional(),
}).refine(
  (d) => d.video_provider === 'none' || d.video_url,
  { message: 'video_url obrigatório quando video_provider != none', path: ['video_url'] },
)

export async function knowledgeRoutes(app) {
  const masterOnly = [app.authenticate, app.requirePapel(['franqueador_master'])]
  const allReaders = [
    app.authenticate,
    app.requirePapel([
      'franqueador_master',
      'franqueado',
      'gerente',
      'gerente_comercial',
      'financeiro',
      'operacional',
      'apresentador',
      'apresentadora',
      'cliente_parceiro',
    ]),
  ]

  // ─── CATEGORIAS ─────────────────────────────────────────────────────────

  app.get('/v1/knowledge/categories', { onRequest: allReaders }, async () => {
    const { rows } = await app.db.query(`
      SELECT id, name, slug, description, icon, sort_order, is_active,
             created_at, updated_at
      FROM knowledge_categories
      WHERE is_active = true
      ORDER BY sort_order ASC, name ASC
    `)
    return rows
  })

  app.post('/v1/knowledge/categories', { onRequest: masterOnly }, async (req, reply) => {
    const parsed = categorySchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const slug = slugify(d.name)
    try {
      const r = await app.db.query(
        `INSERT INTO knowledge_categories (name, slug, description, icon, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [d.name, slug, d.description ?? null, d.icon ?? null, d.sort_order ?? 0, d.is_active ?? true],
      )
      return reply.code(201).send(r.rows[0])
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'Já existe categoria com esse slug' })
      throw e
    }
  })

  app.patch('/v1/knowledge/categories/:id', { onRequest: masterOnly }, async (req, reply) => {
    const parsed = categorySchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const updates = []
    const values = []
    let idx = 1
    for (const [k, v] of Object.entries(d)) {
      if (v !== undefined) {
        updates.push(`${k} = $${idx++}`)
        values.push(v)
      }
    }
    if (d.name) {
      updates.push(`slug = $${idx++}`)
      values.push(slugify(d.name))
    }
    if (updates.length === 0) return reply.code(400).send({ error: 'Nada para atualizar' })
    updates.push(`updated_at = NOW()`)
    values.push(req.params.id)
    const r = await app.db.query(
      `UPDATE knowledge_categories SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    )
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Categoria não encontrada' })
    return r.rows[0]
  })

  app.delete('/v1/knowledge/categories/:id', { onRequest: masterOnly }, async (req, reply) => {
    // soft delete: is_active = false
    const r = await app.db.query(
      `UPDATE knowledge_categories SET is_active = false, updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [req.params.id],
    )
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Categoria não encontrada' })
    return reply.code(204).send()
  })

  // Reordena categorias atualizando sort_order conforme ordem do array recebido (1-indexed).
  // Body: { ids: ['uuid1', 'uuid2', 'uuid3'] }
  app.post('/v1/knowledge/categories/reorder', { onRequest: masterOnly }, async (req, reply) => {
    const reorderSchema = z.object({
      ids: z.array(z.string().uuid()).min(1).max(500),
    })
    const parsed = reorderSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const { ids } = parsed.data
    const client = await app.db.pool.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < ids.length; i++) {
        await client.query(
          `UPDATE knowledge_categories SET sort_order = $1, updated_at = NOW() WHERE id = $2`,
          [i + 1, ids[i]],
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return reply.code(204).send()
  })

  // ─── ARTIGOS ────────────────────────────────────────────────────────────

  // Lista com filtros opcionais. Não-master só vê published.
  app.get('/v1/knowledge/articles', { onRequest: allReaders }, async (req) => {
    const { category_slug, status, q } = req.query ?? {}
    const isMaster = req.user.papel === 'franqueador_master'
    const params = []
    const conds = []

    if (!isMaster) {
      conds.push(`m.status = 'published'`)
    } else if (status) {
      params.push(status)
      conds.push(`m.status = $${params.length}`)
    }

    if (category_slug) {
      params.push(category_slug)
      conds.push(`c.slug = $${params.length}`)
    }

    if (q) {
      params.push(`%${q}%`)
      const i = params.length
      conds.push(`(m.titulo ILIKE $${i} OR m.excerpt ILIKE $${i} OR EXISTS (
        SELECT 1 FROM unnest(m.tags) t WHERE t ILIKE $${i}
      ))`)
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''

    const sql = `
      SELECT
        m.id, m.titulo, m.slug, m.excerpt, m.cover_image_url,
        m.video_provider, m.video_url, m.tags, m.status, m.sort_order,
        m.estimated_read_minutes, m.published_at, m.atualizado_em,
        m.url, m.categoria, m.paginas, m.destaque, m.category_id,
        c.name AS category_name, c.slug AS category_slug
      FROM manuais m
      LEFT JOIN knowledge_categories c ON c.id = m.category_id
      ${where}
      ORDER BY m.destaque DESC, m.sort_order ASC, m.published_at DESC NULLS LAST
    `
    const { rows } = await app.db.query(sql, params)
    return rows
  })

  app.get('/v1/knowledge/articles/:slugOrId', { onRequest: allReaders }, async (req, reply) => {
    const isMaster = req.user.papel === 'franqueador_master'
    const param = req.params.slugOrId
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param)
    const where = isUuid ? 'm.id = $1' : 'm.slug = $1'
    const r = await app.db.query(
      `SELECT
         m.*,
         c.name AS category_name, c.slug AS category_slug
       FROM manuais m
       LEFT JOIN knowledge_categories c ON c.id = m.category_id
       WHERE ${where} ${isMaster ? '' : `AND m.status = 'published'`}`,
      [param],
    )
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Artigo não encontrado' })
    return r.rows[0]
  })

  app.post('/v1/knowledge/articles', { onRequest: masterOnly }, async (req, reply) => {
    const parsed = articleSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const slug = slugify(d.titulo) + '-' + Math.random().toString(36).slice(2, 8)
    const readMin = calcReadMinutes(d.content_markdown)
    const publishedAt = d.status === 'published' ? new Date() : null

    try {
      const r = await app.db.query(
        `INSERT INTO manuais (
           category_id, titulo, slug, excerpt, content_markdown,
           url, cover_image_url, video_provider, video_url, tags,
           status, sort_order, estimated_read_minutes, published_at,
           categoria, paginas, destaque, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
         RETURNING *`,
        [
          d.category_id ?? null, d.titulo, slug, d.excerpt ?? null, d.content_markdown ?? null,
          d.url ?? '', d.cover_image_url ?? null, d.video_provider ?? 'none', d.video_url ?? null,
          d.tags ?? [], d.status ?? 'draft', d.sort_order ?? 0, readMin, publishedAt,
          d.categoria ?? null, d.paginas ?? null, d.destaque ?? false,
          req.user.sub,
        ],
      )
      app.audit?.log?.(req, { action: 'knowledge.article.create', entity_type: 'knowledge_article', entity_id: r.rows[0].id, metadata: { titulo: d.titulo, slug, status: d.status ?? 'draft', category_id: d.category_id ?? null } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return reply.code(201).send(r.rows[0])
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'Slug duplicado, tente novamente' })
      throw e
    }
  })

  app.patch('/v1/knowledge/articles/:id', { onRequest: masterOnly }, async (req, reply) => {
    const parsed = articleSchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const updates = []
    const values = []
    let idx = 1

    for (const [k, v] of Object.entries(d)) {
      if (v !== undefined) {
        updates.push(`${k} = $${idx++}`)
        values.push(v)
      }
    }

    if (d.content_markdown !== undefined) {
      updates.push(`estimated_read_minutes = $${idx++}`)
      values.push(calcReadMinutes(d.content_markdown))
    }

    updates.push(`updated_by = $${idx++}`, `atualizado_em = NOW()`)
    values.push(req.user.sub)

    if (updates.length === 0) return reply.code(400).send({ error: 'Nada para atualizar' })

    values.push(req.params.id)
    const r = await app.db.query(
      `UPDATE manuais SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    )
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Artigo não encontrado' })
    app.audit?.log?.(req, { action: 'knowledge.article.update', entity_type: 'knowledge_article', entity_id: req.params.id, metadata: { changed_fields: Object.keys(d) } })?.catch(err => app.log.error({ err }, 'audit log failed'))
    return r.rows[0]
  })

  app.post('/v1/knowledge/articles/:id/publish', { onRequest: masterOnly }, async (req, reply) => {
    const r = await app.db.query(
      `UPDATE manuais
         SET status = 'published',
             published_at = COALESCE(published_at, NOW()),
             updated_by = $1, atualizado_em = NOW()
       WHERE id = $2 RETURNING id, slug, status, published_at`,
      [req.user.sub, req.params.id],
    )
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Artigo não encontrado' })
    app.audit?.log?.(req, { action: 'knowledge.article.status_change', entity_type: 'knowledge_article', entity_id: req.params.id, metadata: { status_to: 'published' } })?.catch(err => app.log.error({ err }, 'audit log failed'))
    return r.rows[0]
  })

  app.post('/v1/knowledge/articles/:id/archive', { onRequest: masterOnly }, async (req, reply) => {
    const r = await app.db.query(
      `UPDATE manuais SET status = 'archived', updated_by = $1, atualizado_em = NOW()
       WHERE id = $2 RETURNING id, slug, status`,
      [req.user.sub, req.params.id],
    )
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Artigo não encontrado' })
    app.audit?.log?.(req, { action: 'knowledge.article.status_change', entity_type: 'knowledge_article', entity_id: req.params.id, metadata: { status_to: 'archived' } })?.catch(err => app.log.error({ err }, 'audit log failed'))
    return r.rows[0]
  })

  app.delete('/v1/knowledge/articles/:id', { onRequest: masterOnly }, async (req, reply) => {
    const r = await app.db.query('DELETE FROM manuais WHERE id = $1 RETURNING id', [req.params.id])
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Artigo não encontrado' })
    app.audit?.log?.(req, { action: 'knowledge.article.delete', entity_type: 'knowledge_article', entity_id: req.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
    return reply.code(204).send()
  })

  // ─── BUSCA ──────────────────────────────────────────────────────────────

  app.get('/v1/knowledge/search', { onRequest: allReaders }, async (req) => {
    const q = (req.query?.q ?? '').trim()
    if (q.length < 2) return []
    const isMaster = req.user.papel === 'franqueador_master'
    const statusFilter = isMaster ? '' : `AND m.status = 'published'`
    const { rows } = await app.db.query(
      `SELECT m.id, m.slug, m.titulo, m.excerpt, m.tags, m.status,
              m.published_at, c.name AS category_name, c.slug AS category_slug
       FROM manuais m
       LEFT JOIN knowledge_categories c ON c.id = m.category_id
       WHERE (
         m.titulo ILIKE $1
         OR m.excerpt ILIKE $1
         OR EXISTS (SELECT 1 FROM unnest(m.tags) t WHERE t ILIKE $1)
       ) ${statusFilter}
       ORDER BY m.destaque DESC, m.published_at DESC NULLS LAST
       LIMIT 50`,
      [`%${q}%`],
    )
    return rows
  })
}
