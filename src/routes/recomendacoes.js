import { z } from 'zod'

const createSchema = z.object({
  nome_indicado: z.string().min(1),
  recomendante:  z.string().min(1),
  lat:           z.number().optional(),
  lng:           z.number().optional(),
})

const converterSchema = z.object({
  cliente_id: z.string().uuid().optional(),
  celular:    z.string().min(1).optional(),
  cnpj:       z.string().optional(),
  cep:        z.string().optional(),
  cidade:     z.string().optional(),
  estado:     z.string().length(2).optional(),
  fat_anual:  z.number().nonnegative().optional(),
  lat:        z.number().optional(),
  lng:        z.number().optional(),
})

export async function recomendacoesRoutes(app) {
  // GET /v1/recomendacoes
  app.get('/v1/recomendacoes', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT id, nome_indicado, recomendante, status, lat, lng, convertido_em, criado_em
         FROM recomendacoes ORDER BY criado_em DESC`
      )
      return result.rows
    })
  })

  // POST /v1/recomendacoes
  app.post('/v1/recomendacoes', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { nome_indicado, recomendante, lat, lng } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `INSERT INTO recomendacoes (tenant_id, nome_indicado, recomendante, lat, lng)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, nome_indicado, recomendante, status, lat, lng`,
        [tenant_id, nome_indicado, recomendante, lat ?? null, lng ?? null]
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // PATCH /v1/recomendacoes/:id/converter
  app.patch('/v1/recomendacoes/:id/converter', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request, reply) => {
    const parsed = converterSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { cliente_id, celular, cnpj, cep, cidade, estado, fat_anual, lat, lng } = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const recQ = await db.query(
        `SELECT * FROM recomendacoes WHERE id = $1 AND tenant_id = $2 AND status = 'pendente'`,
        [request.params.id, tenant_id],
      )
      const rec = recQ.rows[0]
      if (!rec) return reply.code(400).send({ error: 'Recomendação não encontrada ou já convertida' })

      let finalClienteId = cliente_id

      if (!finalClienteId) {
        const clienteQ = await db.query(
          `INSERT INTO clientes (tenant_id, nome, celular, cnpj, cep, cidade, estado, fat_anual, lat, lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [tenant_id, rec.nome_indicado, celular ?? '', cnpj ?? null,
           cep ?? null, cidade ?? null, estado ?? null,
           fat_anual ?? 0, lat ?? rec.lat ?? null, lng ?? rec.lng ?? null]
        )
        finalClienteId = clienteQ.rows[0].id
      }

      // Score de risco rápido
      let score = 0
      if ((fat_anual ?? 0) > 50000) score += 50
      if (cnpj) score += 20
      const altoRisco = score < 60

      await db.query(
        `UPDATE recomendacoes SET status = 'convertido', convertido_em = NOW() WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, tenant_id],
      )

      return { cliente_id: finalClienteId, score, alto_risco: altoRisco }
    })
  })
}
