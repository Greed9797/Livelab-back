import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import { z } from 'zod'
import { SECURITY } from '../config/security.js'

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
  cidade: z.string().optional(),
  uf: z.string().length(2).optional(),
  plano: z.enum(['Standard', 'Plus', 'Premium', 'Master', 'Trial']).optional(),
})

export async function tenantsRoutes(app) {
  const masterOnly = [app.authenticate, app.requirePapel(['franqueador_master'])]

  // GET /v1/tenants — lista todas as franquias com métricas do mês corrente
  app.get('/v1/tenants', { preHandler: masterOnly }, async (request, reply) => {
    const result = await app.db.query(`
      WITH lives_mes AS (
        SELECT tenant_id,
               COUNT(*)::int                       AS lives_mes,
               COALESCE(SUM(fat_gerado), 0)::float AS gmv_mes
        FROM lives
        WHERE iniciado_em >= date_trunc('month', NOW())
          AND iniciado_em <  date_trunc('month', NOW()) + INTERVAL '1 month'
        GROUP BY tenant_id
      )
      SELECT t.id, t.nome, t.ativo, t.criado_em,
             t.cnpj, t.telefone_contato, t.email_contato,
             t.cidade, t.uf, t.plano,
             u.id    AS owner_id,
             u.nome  AS owner_nome,
             u.email AS owner_email,
             COALESCE(lm.lives_mes, 0) AS lives_mes,
             COALESCE(lm.gmv_mes, 0)   AS gmv_mes
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id AND u.papel = 'franqueado'
      LEFT JOIN lives_mes lm ON lm.tenant_id = t.id
      ORDER BY t.criado_em DESC
    `)
    return result.rows
  })

  // GET /v1/tenants/:id — detalhe
  app.get('/v1/tenants/:id', { preHandler: masterOnly }, async (request, reply) => {
    const result = await app.db.query(`
      WITH lives_mes AS (
        SELECT tenant_id,
               COUNT(*)::int                       AS lives_mes,
               COALESCE(SUM(fat_gerado), 0)::float AS gmv_mes
        FROM lives
        WHERE tenant_id = $1
          AND iniciado_em >= date_trunc('month', NOW())
          AND iniciado_em <  date_trunc('month', NOW()) + INTERVAL '1 month'
        GROUP BY tenant_id
      )
      SELECT t.id, t.nome, t.ativo, t.criado_em,
             t.cnpj, t.telefone_contato, t.email_contato,
             t.cidade, t.uf, t.plano,
             u.id    AS owner_id,
             u.nome  AS owner_nome,
             u.email AS owner_email,
             COALESCE(lm.lives_mes, 0) AS lives_mes,
             COALESCE(lm.gmv_mes, 0)   AS gmv_mes
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id AND u.papel = 'franqueado'
      LEFT JOIN lives_mes lm ON lm.tenant_id = t.id
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
    const senhaHash = await bcrypt.hash(senhaTemp, SECURITY.BCRYPT_ROUNDS)

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

      // S-10: resposta contém senha — proibir cache
      reply.header('Cache-Control', 'no-store')
      reply.header('Pragma', 'no-cache')
      app.audit?.log?.(request, { action: 'tenants.create', entity_type: 'tenant', entity_id: tenant.id, metadata: { nome, email_contato: email_contato ?? null } })?.catch(err => app.log.error({ err }, 'audit log failed'))
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
    app.audit?.log?.(request, { action: 'tenants.update', entity_type: 'tenant', entity_id: request.params.id, metadata: fields })?.catch(err => app.log.error({ err }, 'audit log failed'))
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

  // GET /v1/master/tiktok-apps — visão multi-tenant da integração TikTok Shop.
  // Master only. Retorna status (connected/expired/disconnected), shop_id e
  // expires_at de cada tenant. Não expõe access_token nem refresh_token.
  // Suporta ?status=connected|disconnected|expired pra filtrar.
  app.get('/v1/master/tiktok-apps', { preHandler: masterOnly }, async (request, reply) => {
    const { status } = request.query ?? {}
    const result = await app.db.query(`
      SELECT t.id              AS tenant_id,
             t.nome            AS tenant_nome,
             t.cidade,
             t.uf,
             t.ativo,
             t.tiktok_user_id  AS shop_id,
             t.tiktok_token_expires_at AS expires_at,
             (t.tiktok_access_token IS NOT NULL) AS has_token
      FROM tenants t
      ORDER BY t.nome ASC
    `)
    const now = Date.now()
    const apps = result.rows.map((r) => {
      const expiresAtMs = r.expires_at ? new Date(r.expires_at).getTime() : null
      let appStatus = 'disconnected'
      if (r.has_token && expiresAtMs && expiresAtMs > now) appStatus = 'connected'
      else if (r.has_token && expiresAtMs && expiresAtMs <= now) appStatus = 'expired'
      return {
        tenant_id: r.tenant_id,
        tenant_nome: r.tenant_nome,
        cidade: r.cidade,
        uf: r.uf,
        ativo: r.ativo,
        connected: appStatus === 'connected',
        status: appStatus,
        shop_id: r.shop_id,
        expires_at: r.expires_at,
      }
    })
    if (status && ['connected', 'disconnected', 'expired'].includes(status)) {
      return apps.filter((a) => a.status === status)
    }
    return apps
  })
}
