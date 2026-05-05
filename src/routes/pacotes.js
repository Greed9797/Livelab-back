import { z } from 'zod'

const createSchema = z.object({
  nome:            z.string().min(1),
  descricao:       z.string().optional(),
  valor_fixo:      z.number().min(0),
  comissao_pct:    z.number().min(0).max(100).default(0),
  horas_incluidas: z.number().min(0),
})

const updateSchema = createSchema.partial().extend({
  ativo: z.boolean().optional(),
})

const COLS = `id, nome, descricao, valor_fixo, comissao_pct, horas_incluidas, ativo, criado_em`

export async function pacotesRoutes(app) {
  const access = app.requirePapel(['franqueado', 'franqueador_master', 'gerente'])

  // GET /v1/pacotes
  app.get('/v1/pacotes', { preHandler: access }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS} FROM pacotes ORDER BY ativo DESC, valor_fixo ASC`
      )
      return result.rows
    })
  })

  // POST /v1/pacotes
  app.post('/v1/pacotes', { preHandler: access }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { nome, descricao, valor_fixo, comissao_pct, horas_incluidas } = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `INSERT INTO pacotes (tenant_id, nome, descricao, valor_fixo, comissao_pct, horas_incluidas)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLS}`,
        [tenant_id, nome, descricao ?? null, valor_fixo, comissao_pct, horas_incluidas]
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // PATCH /v1/pacotes/:id
  app.patch('/v1/pacotes/:id', { preHandler: access }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ')
    const values = [request.params.id, ...fields.map((f) => updates[f])]

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE pacotes SET ${setClauses}
         WHERE id = $1
         RETURNING ${COLS}`,
        values
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Pacote não encontrado' })
      return result.rows[0]
    })
  })

  // DELETE /v1/pacotes/:id — desativa
  app.delete('/v1/pacotes/:id', { preHandler: access }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE pacotes SET ativo = false WHERE id = $1 RETURNING id`,
        [request.params.id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Pacote não encontrado' })
      return reply.code(204).send()
    })
  })
}
