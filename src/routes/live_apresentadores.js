import { z } from 'zod'

const addApresentadorSchema = z.object({
  apresentador_id: z.string().uuid(),
})

export async function liveApresentadoresRoutes(app) {

  // POST /v1/lives/:liveId/apresentadores — add an apresentador to a live
  app.post('/v1/lives/:liveId/apresentadores', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'gerente'])],
  }, async (request, reply) => {
    const parsed = addApresentadorSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { liveId } = request.params
    const { apresentador_id } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      // Verify live exists and belongs to tenant
      const liveQ = await db.query(
        `SELECT id FROM lives WHERE id = $1`,
        [liveId]
      )
      if (!liveQ.rows[0]) return reply.code(404).send({ error: 'Live não encontrada' })

      // Verify apresentador exists and belongs to tenant
      const userQ = await db.query(
        `SELECT id FROM users WHERE id = $1`,
        [apresentador_id]
      )
      if (!userQ.rows[0]) return reply.code(404).send({ error: 'Apresentador não encontrado' })

      // Insert — ON CONFLICT DO NOTHING to ignore duplicates
      await db.query(
        `INSERT INTO live_apresentadores (live_id, apresentador_id)
         VALUES ($1, $2)
         ON CONFLICT (live_id, apresentador_id) DO NOTHING`,
        [liveId, apresentador_id]
      )

      return reply.code(201).send({ ok: true })
    })
  })

  // DELETE /v1/lives/:liveId/apresentadores/:apresentadorId — remove an apresentador from a live
  app.delete('/v1/lives/:liveId/apresentadores/:apresentadorId', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'gerente'])],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { liveId, apresentadorId } = request.params

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM live_apresentadores
         WHERE live_id = $1 AND apresentador_id = $2`,
        [liveId, apresentadorId]
      )

      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'Vínculo não encontrado' })
      }

      return { ok: true }
    })
  })

  // GET /v1/lives/:liveId/apresentadores — list all extra apresentadores for a live
  app.get('/v1/lives/:liveId/apresentadores', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'gerente'])],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { liveId } = request.params

    return app.withTenant(tenant_id, async (db) => {
      // Verify live exists
      const liveQ = await db.query(`SELECT id FROM lives WHERE id = $1`, [liveId])
      if (!liveQ.rows[0]) return reply.code(404).send({ error: 'Live não encontrada' })

      const result = await db.query(
        `SELECT u.id, u.nome, u.cargo
         FROM live_apresentadores la
         JOIN users u ON u.id = la.apresentador_id
         WHERE la.live_id = $1
         ORDER BY la.criado_em`,
        [liveId]
      )

      return result.rows
    })
  })
}
