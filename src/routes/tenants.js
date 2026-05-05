import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import { z } from 'zod'

const criarFranquiaSchema = z.object({
  nome: z.string().min(2),
  cnpj: z.string().optional(),
  telefone_contato: z.string().optional(),
  email_contato: z.string().email().optional(),
  franqueado: z.object({
    nome: z.string().min(2),
    email: z.string().email(),
    senha_temporaria: z.string().min(6, 'Senha temporária deve ter no mínimo 6 caracteres').optional(),
  }),
})

const atualizarTenantSchema = z.object({
  nome: z.string().min(2).optional(),
  cnpj: z.string().optional(),
  telefone_contato: z.string().optional(),
  email_contato: z.string().email().optional(),
})

export async function tenantsRoutes(app) {
  const masterOnly = [app.authenticate, app.requirePapel(['franqueador_master'])]

  // GET /v1/tenants — lista todas as franquias
  app.get('/v1/tenants', { preHandler: masterOnly }, async (request, reply) => {
    const result = await app.db.query(`
      SELECT t.id, t.nome, t.ativo, t.criado_em,
             t.cnpj, t.telefone_contato, t.email_contato,
             u.id   AS owner_id,
             u.nome AS owner_nome,
             u.email AS owner_email
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id AND u.papel = 'franqueado'
      ORDER BY t.criado_em DESC
    `)
    return result.rows
  })

  // GET /v1/tenants/:id — detalhe
  app.get('/v1/tenants/:id', { preHandler: masterOnly }, async (request, reply) => {
    const result = await app.db.query(`
      SELECT t.id, t.nome, t.ativo, t.criado_em,
             t.cnpj, t.telefone_contato, t.email_contato,
             u.id   AS owner_id,
             u.nome AS owner_nome,
             u.email AS owner_email
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id AND u.papel = 'franqueado'
      WHERE t.id = $1
    `, [request.params.id])
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Franquia não encontrada' })
    return result.rows[0]
  })

  // POST /v1/tenants — criar tenant + franqueado owner (transação atômica)
  app.post('/v1/tenants', { preHandler: masterOnly }, async (request, reply) => {
    const parsed = criarFranquiaSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const { nome, cnpj, telefone_contato, email_contato, franqueado } = parsed.data

    // Verificar email único globalmente
    const emailCheck = await app.db.query('SELECT id FROM users WHERE email = $1', [franqueado.email])
    if (emailCheck.rows.length > 0) {
      return reply.code(409).send({ error: 'E-mail do franqueado já cadastrado' })
    }

    const senhaTemp = franqueado.senha_temporaria ?? crypto.randomBytes(8).toString('hex')
    const senhaHash = await bcrypt.hash(senhaTemp, 12)

    const client = await app.db.pool.connect()
    try {
      await client.query('BEGIN')

      const tenantResult = await client.query(
        `INSERT INTO tenants (nome, cnpj, telefone_contato, email_contato, ativo)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, nome, cnpj, telefone_contato, email_contato, ativo, criado_em`,
        [nome, cnpj ?? null, telefone_contato ?? null, email_contato ?? null]
      )
      const tenant = tenantResult.rows[0]

      const userResult = await client.query(
        `INSERT INTO users (tenant_id, nome, email, senha_hash, papel, ativo, criado_por)
         VALUES ($1, $2, $3, $4, 'franqueado', true, $5)
         RETURNING id, nome, email, papel, ativo, criado_em`,
        [tenant.id, franqueado.nome, franqueado.email, senhaHash, request.user.sub]
      )
      const owner = userResult.rows[0]

      await client.query('COMMIT')

      return reply.code(201).send({ tenant, owner, senha_temporaria: senhaTemp })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  // PATCH /v1/tenants/:id — atualizar dados
  app.patch('/v1/tenants/:id', { preHandler: masterOnly }, async (request, reply) => {
    const parsed = atualizarTenantSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const fields = parsed.data
    const updates = []
    const values = []
    let idx = 1

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        updates.push(`${key} = $${idx++}`)
        values.push(val)
      }
    }

    if (updates.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    values.push(request.params.id)
    const result = await app.db.query(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    )
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Franquia não encontrada' })
    return result.rows[0]
  })

  // PATCH /v1/tenants/:id/status — ativar/desativar (cascata em users)
  app.patch('/v1/tenants/:id/status', { preHandler: masterOnly }, async (request, reply) => {
    const { ativo } = request.body ?? {}
    if (typeof ativo !== 'boolean') {
      return reply.code(400).send({ error: '"ativo" deve ser boolean' })
    }

    const client = await app.db.pool.connect()
    try {
      await client.query('BEGIN')
      const tenantResult = await client.query(
        'UPDATE tenants SET ativo = $1 WHERE id = $2 RETURNING id, nome, ativo',
        [ativo, request.params.id]
      )
      if (tenantResult.rows.length === 0) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'Franquia não encontrada' })
      }
      await client.query(
        'UPDATE users SET ativo = $1 WHERE tenant_id = $2',
        [ativo, request.params.id]
      )
      if (!ativo) {
        // Revogar todas as sessões do tenant
        await client.query(
          'DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)',
          [request.params.id]
        )
      }
      await client.query('COMMIT')
      return tenantResult.rows[0]
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })
}
