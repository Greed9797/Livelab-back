import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import { z } from 'zod'

const convidarSchema = z.object({
  nome: z.string().min(2),
  email: z.string().email(),
  papel: z.enum([
    'gerente', 'gerente_comercial', 'financeiro', 'operacional',
    'apresentador', 'apresentadora', 'cliente_parceiro',
  ]),
  cliente_id: z.string().uuid().optional(),
  apresentadora_id: z.string().uuid().optional(),
}).refine(d => d.papel !== 'cliente_parceiro' || !!d.cliente_id, {
  message: 'cliente_id é obrigatório para papel cliente_parceiro',
})

const atualizarSchema = z.object({
  nome: z.string().min(2).optional(),
  papel: z.enum([
    'gerente', 'gerente_comercial', 'financeiro', 'operacional',
    'apresentador', 'apresentadora', 'cliente_parceiro',
  ]).optional(),
  ativo: z.boolean().optional(),
})

export async function usuariosRoutes(app) {
  const rbac = [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master'])]

  // GET /v1/usuarios?papel=...&ativo=...
  app.get('/v1/usuarios', { preHandler: rbac }, async (request, reply) => {
    const { papel, ativo } = request.query
    const conditions = ['tenant_id = $1', 'id != $2']
    const values = [request.user.tenant_id, request.user.sub]
    let idx = 3

    if (papel) {
      conditions.push(`papel = $${idx++}`)
      values.push(papel)
    }
    if (ativo !== undefined) {
      conditions.push(`ativo = $${idx++}`)
      values.push(ativo === 'true')
    }

    const db = await app.dbTenant(request.user.tenant_id)
    try {
      const result = await db.query(
        `SELECT id, nome, email, papel, ativo, criado_em, criado_por
         FROM users
         WHERE ${conditions.join(' AND ')}
         ORDER BY criado_em DESC`,
        values
      )
      return result.rows
    } finally {
      db.release()
    }
  })

  // POST /v1/usuarios/convidar
  app.post('/v1/usuarios/convidar', { preHandler: rbac }, async (request, reply) => {
    const parsed = convidarSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const { nome, email, papel, cliente_id, apresentadora_id } = parsed.data
    const tenantId = request.user.tenant_id

    const existing = await app.db.query('SELECT id FROM users WHERE email = $1', [email])
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'E-mail já cadastrado' })
    }

    const senhaTemp = crypto.randomBytes(8).toString('hex')
    const senhaHash = await bcrypt.hash(senhaTemp, 12)

    const db = await app.dbTenant(tenantId)
    try {
      await db.query('BEGIN')

      // Pré-validação: cliente_parceiro precisa de cliente DISPONÍVEL (sem user_id já vinculado)
      // antes de criar o user — evita orphan onde INSERT users sucede mas UPDATE falha,
      // deixando cliente alheio acessível pelo novo user via fallback de email.
      if (papel === 'cliente_parceiro') {
        const check = await db.query(
          `SELECT user_id FROM clientes WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          [cliente_id, tenantId],
        )
        if (check.rowCount === 0) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cliente não encontrado no tenant' })
        }
        if (check.rows[0].user_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cliente já vinculado a outro usuário.' })
        }
      }

      const { rows } = await db.query(
        `INSERT INTO users (tenant_id, nome, email, senha_hash, papel, ativo, criado_por)
         VALUES ($1, $2, $3, $4, $5, true, $6)
         RETURNING id, nome, email, papel, ativo, criado_em`,
        [tenantId, nome, email, senhaHash, papel, request.user.sub]
      )
      const newUser = rows[0]

      if (papel === 'cliente_parceiro') {
        const updated = await db.query(
          `UPDATE clientes SET user_id = $1 WHERE id = $2 AND tenant_id = $3 AND user_id IS NULL`,
          [newUser.id, cliente_id, tenantId]
        )
        if (updated.rowCount === 0) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cliente foi vinculado por outra requisição. Tente novamente.' })
        }
      }

      if ((papel === 'apresentador' || papel === 'apresentadora') && apresentadora_id) {
        await db.query(
          `UPDATE apresentadoras SET user_id = $1 WHERE id = $2 AND tenant_id = $3`,
          [newUser.id, apresentadora_id, tenantId]
        )
      }

      await db.query('COMMIT')
      return reply.code(201).send({ ...newUser, senha_temporaria: senhaTemp })
    } catch (e) {
      await db.query('ROLLBACK')
      throw e
    } finally {
      db.release()
    }
  })

  // PATCH /v1/usuarios/:id
  app.patch('/v1/usuarios/:id', { preHandler: rbac }, async (request, reply) => {
    if (request.params.id === request.user.sub) {
      return reply.code(400).send({ error: 'Use /auth/senha para alterar seus próprios dados' })
    }

    const parsed = atualizarSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const fields = parsed.data
    if (Object.keys(fields).length === 0) {
      return reply.code(400).send({ error: 'Nenhum campo para atualizar' })
    }

    const updates = []
    const values = []
    let idx = 1

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        updates.push(`${key} = $${idx++}`)
        values.push(val)
      }
    }

    const db = await app.dbTenant(request.user.tenant_id)
    try {
      if (fields.ativo === false) {
        await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [request.params.id])
      }

      values.push(request.params.id, request.user.tenant_id)
      const result = await db.query(
        `UPDATE users SET ${updates.join(', ')}
         WHERE id = $${idx} AND tenant_id = $${idx + 1}
         RETURNING id, nome, email, papel, ativo, criado_em`,
        values
      )
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Usuário não encontrado' })
      }
      return result.rows[0]
    } finally {
      db.release()
    }
  })

  // POST /v1/usuarios/:id/reset-senha
  app.post('/v1/usuarios/:id/reset-senha', { preHandler: rbac }, async (request, reply) => {
    if (request.params.id === request.user.sub) {
      return reply.code(400).send({ error: 'Use /auth/senha para alterar sua própria senha' })
    }

    const novaSenha = crypto.randomBytes(8).toString('hex')
    const senhaHash = await bcrypt.hash(novaSenha, 12)

    const db = await app.dbTenant(request.user.tenant_id)
    try {
      const result = await db.query(
        `UPDATE users SET senha_hash = $1
         WHERE id = $2 AND tenant_id = $3
         RETURNING id`,
        [senhaHash, request.params.id, request.user.tenant_id]
      )
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Usuário não encontrado' })
      }
      await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [request.params.id])
      return { senha_temporaria: novaSenha }
    } finally {
      db.release()
    }
  })

  // DELETE /v1/usuarios/:id — soft delete
  app.delete('/v1/usuarios/:id', { preHandler: rbac }, async (request, reply) => {
    if (request.params.id === request.user.sub) {
      return reply.code(400).send({ error: 'Não é possível desativar a si mesmo' })
    }

    const db = await app.dbTenant(request.user.tenant_id)
    try {
      await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [request.params.id])

      const result = await db.query(
        `UPDATE users SET ativo = false
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, nome, email, papel, ativo`,
        [request.params.id, request.user.tenant_id]
      )
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Usuário não encontrado' })
      }
      return reply.code(204).send()
    } finally {
      db.release()
    }
  })
}
