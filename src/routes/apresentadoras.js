import { z } from 'zod'
import { READ_APRESENTADORAS, WRITE_APRESENTADORAS } from '../config/role_groups.js'

const createSchema = z.object({
  nome:            z.string().min(1),
  telefone:        z.string().optional(),
  cargo:           z.string().optional(),
  email:           z.string().email().optional(),
  cpf_cnpj:        z.string().optional(),
  cidade:          z.string().optional(),
  fixo:            z.number().min(0).default(0),
  comissao_pct:    z.number().min(0).max(100).default(0),
  meta_diaria_gmv: z.number().min(0).default(0),
  observacoes:     z.string().optional(),
  link_contrato:   z.string().optional(),
  data_aniversario: z.string().optional(),
  data_inicio:     z.string().optional(),
  data_fim:        z.string().optional(),
})

const updateSchema = createSchema.partial().extend({
  ativo: z.boolean().optional(),
})

const COLS = `id, nome, telefone, cargo, email, cpf_cnpj, cidade, ativo, fixo, comissao_pct, meta_diaria_gmv, observacoes, link_contrato, data_aniversario, data_inicio, data_fim, criado_em`

export async function apresentadorasRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_APRESENTADORAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_APRESENTADORAS)]

  // GET /v1/apresentadoras
  app.get('/v1/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS} FROM apresentadoras a
         WHERE a.tenant_id = $1::uuid
         ORDER BY a.ativo DESC, a.nome ASC`,
        [tenant_id]
      )
      return result.rows
    })
  })

  // GET /v1/apresentadoras/:id
  app.get('/v1/apresentadoras/:id', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS} FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return result.rows[0]
    })
  })

  // POST /v1/apresentadoras
  app.post('/v1/apresentadoras', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `INSERT INTO apresentadoras (tenant_id, nome, telefone, cargo, email, cpf_cnpj, cidade, fixo, comissao_pct, meta_diaria_gmv, observacoes, link_contrato, data_aniversario, data_inicio, data_fim)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING ${COLS}`,
        [tenant_id, d.nome, d.telefone ?? null, d.cargo ?? null, d.email ?? null,
         d.cpf_cnpj ?? null, d.cidade ?? null, d.fixo, d.comissao_pct, d.meta_diaria_gmv, d.observacoes ?? null,
         d.link_contrato ?? null, d.data_aniversario ?? null, d.data_inicio ?? null, d.data_fim ?? null]
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // PATCH /v1/apresentadoras/:id
  app.patch('/v1/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(', ')
    const values = [request.params.id, tenant_id, ...fields.map((f) => updates[f])]

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE apresentadoras SET ${setClauses}
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING ${COLS}`,
        values
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return result.rows[0]
    })
  })

  // DELETE /v1/apresentadoras/:id — desativa (soft delete)
  app.delete('/v1/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE apresentadoras SET ativo = false
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING id`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return reply.code(204).send()
    })
  })
}
