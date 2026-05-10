import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import { z } from 'zod'
import { SECURITY } from '../config/security.js'
import { notify } from '../services/mailer.js'

const PAPEL_LABELS = {
  gerente: 'Gerente',
  gerente_comercial: 'Gerente Comercial',
  financeiro: 'Financeiro',
  operacional: 'Operacional',
  apresentador: 'Apresentador',
  apresentadora: 'Apresentadora',
  cliente_parceiro: 'Cliente Parceiro',
}

const _frontendUrl = () =>
  (process.env.FRONTEND_URL ?? 'https://livelab-3601f.web.app').replace(/\/+$/, '')

const convidarSchema = z.object({
  nome: z.string().min(2),
  email: z.string().email(),
  papel: z.enum([
    'gerente', 'gerente_comercial', 'financeiro', 'operacional',
    'apresentador', 'apresentadora', 'cliente_parceiro',
  ]),
  cliente_id: z.string().uuid().optional(),
  apresentadora_id: z.string().uuid().optional(),
  senha_temporaria: z.string().min(6, 'Senha temporária deve ter no mínimo 6 caracteres').optional(),
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

    return app.withTenant(request.user.tenant_id, async (db) => {
      const result = await db.query(
        `SELECT id, nome, email, papel, ativo, criado_em, criado_por
         FROM users
         WHERE ${conditions.join(' AND ')}
         ORDER BY criado_em DESC`,
        values
      )
      return result.rows
    })
  })

  // POST /v1/usuarios/convidar
  app.post('/v1/usuarios/convidar', { preHandler: rbac }, async (request, reply) => {
    const parsed = convidarSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const { nome, email, papel, cliente_id, apresentadora_id, senha_temporaria } = parsed.data
    const tenantId = request.user.tenant_id

    // F4: convite via email. Senha inicial é placeholder aleatório (NÃO usável
    // pra login) — usuário define a real ao aceitar o convite via /aceitar-convite.
    // Fallback: se mailer não está configurado (sem RESEND_API_KEY) ou se o caller
    // forçou senha_temporaria, mantemos comportamento legado pra não quebrar dev.
    const mailerEnabled = !!process.env.RESEND_API_KEY
    const useInviteFlow = mailerEnabled && !senha_temporaria

    const senhaInicial = senha_temporaria
      ?? crypto.randomBytes(32).toString('hex') // só pra ter algo no campo NOT NULL
    const senhaHash = await bcrypt.hash(senhaInicial, SECURITY.BCRYPT_ROUNDS)

    // Token de convite (72h). Hash gravado, plaintext só vai por email.
    const inviteRawToken = useInviteFlow
      ? crypto.randomBytes(32).toString('hex')
      : null
    const inviteTokenHash = inviteRawToken
      ? crypto.createHash('sha256').update(inviteRawToken).digest('hex')
      : null
    const inviteExpiraEm = useInviteFlow
      ? new Date(Date.now() + 72 * 60 * 60 * 1000)
      : null

    return app.withTenant(tenantId, async (db) => {
      try {
        await db.query('BEGIN')

        // S-02: checagem de email apenas dentro do tenant (UNIQUE composto).
        // Antes vazava enumeração cross-tenant via 409.
        const existing = await db.query(
          'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
          [email, tenantId],
        )
        if (existing.rows.length > 0) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'E-mail já cadastrado neste tenant' })
        }

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
          `INSERT INTO users (
              tenant_id, nome, email, senha_hash, papel, ativo, criado_por,
              invite_token_hash, invite_expira_em, primeiro_acesso
            )
           VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, false)
           RETURNING id, nome, email, papel, ativo, criado_em`,
          [
            tenantId, nome, email, senhaHash, papel, request.user.sub,
            inviteTokenHash, inviteExpiraEm,
          ]
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

        // F4: dispara email de convite (fire-and-forget — não bloqueia resposta).
        if (useInviteFlow) {
          // Pega nome do tenant pra personalizar email.
          const tenantRow = await db.query(`SELECT nome FROM tenants WHERE id = $1`, [tenantId])
          const tenantNome = tenantRow.rows[0]?.nome ?? 'LiveShop'

          const link = `${_frontendUrl()}/aceitar-convite?token=${inviteRawToken}`
          notify({
            app,
            tenantId,
            to: email,
            template: 'convite_usuario',
            vars: {
              nome,
              papel_label: PAPEL_LABELS[papel] ?? papel,
              link,
              tenant_nome: tenantNome,
            },
          }).catch((err) => {
            app.log?.warn?.({ err }, '[usuarios] falha ao enviar email convite_usuario')
          })

          reply.header('Cache-Control', 'no-store')
          reply.header('Pragma', 'no-cache')
          return reply.code(201).send({
            ...newUser,
            invite_enviado: true,
            invite_expira_em: inviteExpiraEm,
          })
        }

        // Fallback legado — sem mailer ou senha forçada pelo caller.
        // S-10: resposta contém senha — proibir cache em proxies/CDN.
        reply.header('Cache-Control', 'no-store')
        reply.header('Pragma', 'no-cache')
        return reply.code(201).send({
          ...newUser,
          senha_temporaria: senhaInicial,
          invite_enviado: false,
          warning: mailerEnabled
            ? 'Senha definida pelo administrador (sem fluxo de convite).'
            : 'Mailer não configurado — usando senha temporária. Configure RESEND_API_KEY para o fluxo de convite por email.',
        })
      } catch (e) {
        await db.query('ROLLBACK')
        throw e
      }
    })
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

    // S-01: bloquear escalada de papel via PATCH.
    // - franqueado/franqueador_master nunca atribuíveis (criados via /v1/tenants).
    // - 'gerente' apenas franqueador_master pode atribuir.
    const PAPEIS_PROIBIDOS = new Set(['franqueado', 'franqueador_master'])
    if (fields.papel && PAPEIS_PROIBIDOS.has(fields.papel)) {
      return reply.code(403).send({ error: 'Este papel não pode ser atribuído manualmente' })
    }
    if (fields.papel === 'gerente' && request.user.papel !== 'franqueador_master') {
      return reply.code(403).send({ error: 'Somente franqueador_master pode atribuir papel gerente' })
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

    return app.withTenant(request.user.tenant_id, async (db) => {
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
    })
  })

  // POST /v1/usuarios/:id/reset-senha
  app.post('/v1/usuarios/:id/reset-senha', { preHandler: rbac }, async (request, reply) => {
    if (request.params.id === request.user.sub) {
      return reply.code(400).send({ error: 'Use /auth/senha para alterar sua própria senha' })
    }

    const novaSenha = crypto.randomBytes(8).toString('hex')
    const senhaHash = await bcrypt.hash(novaSenha, 12)

    return app.withTenant(request.user.tenant_id, async (db) => {
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
      // S-10: resposta contém senha — proibir cache em proxies/CDN
      reply.header('Cache-Control', 'no-store')
      reply.header('Pragma', 'no-cache')
      return { senha_temporaria: novaSenha }
    })
  })

  // POST /v1/usuarios/:id/force-logout
  // Invalida todos os tokens (refresh + access JWT) imediatamente.
  // Use case: master suspeita que conta foi comprometida e quer matar
  // todas as sessões agora — sem esperar TTL de 15min do JWT.
  app.post('/v1/usuarios/:id/force-logout', { preHandler: rbac }, async (request, reply) => {
    return app.withTenant(request.user.tenant_id, async (db) => {
      // Bump token_version: invalida TODOS os JWTs já emitidos (app.authenticate
      // checa contra DB.token_version).
      const result = await db.query(
        `UPDATE users
            SET token_version = token_version + 1,
                atualizado_em = NOW()
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, token_version`,
        [request.params.id, request.user.tenant_id]
      )
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Usuário não encontrado' })
      }
      // Revoga refresh tokens em paralelo (defesa em profundidade).
      await db.query(
        `UPDATE refresh_tokens SET revogado = true WHERE user_id = $1`,
        [request.params.id]
      )
      return { ok: true, token_version: result.rows[0].token_version }
    })
  })

  // DELETE /v1/usuarios/:id — soft delete
  app.delete('/v1/usuarios/:id', { preHandler: rbac }, async (request, reply) => {
    if (request.params.id === request.user.sub) {
      return reply.code(400).send({ error: 'Não é possível desativar a si mesmo' })
    }

    return app.withTenant(request.user.tenant_id, async (db) => {
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
    })
  })
}
