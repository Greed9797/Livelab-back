import { z } from 'zod'
import { READ_CLIENTE_NOTAS, WRITE_CLIENTE_NOTAS } from '../config/role_groups.js'

/**
 * Notas/histórico de contato em clientes parceiros ativos.
 * Diferente de leads.historico_contatos (JSONB inline) — aqui cada nota
 * é uma row própria com autor, tipo e timestamps editáveis.
 *
 * Endpoints:
 *   GET    /v1/clientes/:clienteId/notas
 *   POST   /v1/clientes/:clienteId/notas
 *   PATCH  /v1/clientes/:clienteId/notas/:notaId
 *   DELETE /v1/clientes/:clienteId/notas/:notaId
 *
 * Permissões: leitura ampla (todos read_clientes), escrita inclui
 * suporte+marketing além do admin/comercial padrão.
 *
 * RLS por tenant garantido via policies da migration 064.
 */

const notaSchema = z.object({
  texto: z.string().min(1, 'Texto obrigatório').max(5000),
  tipo: z.enum(['nota', 'ligacao', 'reuniao', 'reclamacao', 'elogio'])
    .optional().default('nota'),
})

export async function clienteNotasRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_CLIENTE_NOTAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_CLIENTE_NOTAS)]

  // GET — lista notas do cliente
  app.get('/v1/clientes/:clienteId/notas', { onRequest: readAccess }, async (req) => {
    const { tenant_id } = req.user
    return app.withTenant(tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT id, cliente_id, autor_id, autor_nome, texto, tipo,
                criado_em, editado_em
           FROM cliente_notas
          WHERE cliente_id = $1::uuid
            AND tenant_id = $2::uuid
          ORDER BY criado_em DESC
          LIMIT 200`,
        [req.params.clienteId, tenant_id],
      )
      return rows
    })
  })

  // POST — criar nota
  app.post('/v1/clientes/:clienteId/notas', { onRequest: writeAccess }, async (req, reply) => {
    const parsed = notaSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub: autorId, nome: autorNome } = req.user
    return app.withTenant(tenant_id, async (db) => {
      // Validar que cliente existe e é do tenant (defesa em profundidade)
      const cliente = await db.query(
        `SELECT id FROM clientes WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [req.params.clienteId, tenant_id],
      )
      if (cliente.rows.length === 0) {
        return reply.code(404).send({ error: 'Cliente não encontrado' })
      }

      const { rows } = await db.query(
        `INSERT INTO cliente_notas
           (tenant_id, cliente_id, autor_id, autor_nome, texto, tipo)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
         RETURNING id, cliente_id, autor_id, autor_nome, texto, tipo,
                   criado_em, editado_em`,
        [tenant_id, req.params.clienteId, autorId, autorNome ?? 'Usuário', parsed.data.texto, parsed.data.tipo],
      )
      return reply.code(201).send(rows[0])
    })
  })

  // PATCH — editar nota (só autor ou franqueado/master pode editar)
  app.patch('/v1/clientes/:clienteId/notas/:notaId', { onRequest: writeAccess }, async (req, reply) => {
    const parsed = notaSchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub: userId, papel } = req.user
    return app.withTenant(tenant_id, async (db) => {
      const existing = await db.query(
        `SELECT autor_id FROM cliente_notas
          WHERE id = $1::uuid AND cliente_id = $2::uuid AND tenant_id = $3::uuid`,
        [req.params.notaId, req.params.clienteId, tenant_id],
      )
      if (existing.rows.length === 0) {
        return reply.code(404).send({ error: 'Nota não encontrada' })
      }

      const isOwner = existing.rows[0].autor_id === userId
      const isAdmin = ['franqueador_master', 'franqueado'].includes(papel)
      if (!isOwner && !isAdmin) {
        return reply.code(403).send({ error: 'Sem permissão pra editar esta nota' })
      }

      const updates = []
      const values = []
      let idx = 1
      if (parsed.data.texto !== undefined) {
        updates.push(`texto = $${idx++}`); values.push(parsed.data.texto)
      }
      if (parsed.data.tipo !== undefined) {
        updates.push(`tipo = $${idx++}`); values.push(parsed.data.tipo)
      }
      if (updates.length === 0) return reply.code(400).send({ error: 'Nada para atualizar' })

      updates.push(`editado_em = NOW()`)
      values.push(req.params.notaId)

      const { rows } = await db.query(
        `UPDATE cliente_notas SET ${updates.join(', ')}
          WHERE id = $${idx} RETURNING *`,
        values,
      )
      return rows[0]
    })
  })

  // DELETE — só autor ou admin
  app.delete('/v1/clientes/:clienteId/notas/:notaId', { onRequest: writeAccess }, async (req, reply) => {
    const { tenant_id, sub: userId, papel } = req.user
    return app.withTenant(tenant_id, async (db) => {
      const existing = await db.query(
        `SELECT autor_id FROM cliente_notas
          WHERE id = $1::uuid AND cliente_id = $2::uuid AND tenant_id = $3::uuid`,
        [req.params.notaId, req.params.clienteId, tenant_id],
      )
      if (existing.rows.length === 0) {
        return reply.code(404).send({ error: 'Nota não encontrada' })
      }
      const isOwner = existing.rows[0].autor_id === userId
      const isAdmin = ['franqueador_master', 'franqueado'].includes(papel)
      if (!isOwner && !isAdmin) {
        return reply.code(403).send({ error: 'Sem permissão pra deletar esta nota' })
      }
      await db.query('DELETE FROM cliente_notas WHERE id = $1::uuid', [req.params.notaId])
      return reply.code(204).send()
    })
  })
}
