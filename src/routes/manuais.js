import { z } from 'zod'

const manualSchema = z.object({
  titulo: z.string().min(2, 'Título obrigatório'),
  url: z.string().url('URL inválida'),
  categoria: z.string().optional(),
  paginas: z.number().int().positive().optional(),
  destaque: z.boolean().optional().default(false),
})

/**
 * Rotas de manuais e documentos
 * GET    /v1/manuais — lista documentos disponíveis para perfis operacionais
 * POST   /v1/manuais — cria documento (master only)
 * PATCH  /v1/manuais/:id — atualiza (master only)
 * DELETE /v1/manuais/:id — remove (master only)
 */
export async function manuaisRoutes(app) {
  const masterOnly = [app.authenticate, app.requirePapel(['franqueador_master'])]

  app.get(
    '/v1/manuais',
    {
      onRequest: [
        app.authenticate,
        app.requirePapel(['franqueador_master', 'franqueado', 'gerente', 'cliente_parceiro']),
      ],
    },
    async (_req, reply) => {
      const { rows } = await app.db.query(`
        SELECT id, titulo, url, atualizado_em, categoria, paginas, destaque
        FROM manuais
        ORDER BY destaque DESC, atualizado_em DESC
      `)
      return reply.send(rows)
    }
  )

  app.post('/v1/manuais', { preHandler: masterOnly }, async (request, reply) => {
    const parsed = manualSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const { titulo, url, categoria, paginas, destaque } = parsed.data
    const result = await app.db.query(
      `INSERT INTO manuais (titulo, url, categoria, paginas, destaque)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, titulo, url, categoria, paginas, destaque, atualizado_em`,
      [titulo, url, categoria ?? null, paginas ?? null, destaque ?? false]
    )
    return reply.code(201).send(result.rows[0])
  })

  app.patch('/v1/manuais/:id', { preHandler: masterOnly }, async (request, reply) => {
    const parsed = manualSchema.partial().safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const fields = parsed.data
    const updates = []
    const values = []
    let idx = 1
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        updates.push(`${k} = $${idx++}`)
        values.push(v)
      }
    }
    if (updates.length === 0) return reply.code(400).send({ error: 'Nada para atualizar' })
    updates.push('atualizado_em = NOW()')
    values.push(request.params.id)
    const result = await app.db.query(
      `UPDATE manuais SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    )
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Manual não encontrado' })
    return result.rows[0]
  })

  app.delete('/v1/manuais/:id', { preHandler: masterOnly }, async (request, reply) => {
    const result = await app.db.query('DELETE FROM manuais WHERE id = $1 RETURNING id', [request.params.id])
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Manual não encontrado' })
    return reply.code(204).send()
  })
}
