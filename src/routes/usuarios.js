import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import { z } from 'zod'
import { SECURITY } from '../config/security.js'
import { DEFAULT_APRESENTADORA_FIXO, MAX_APRESENTADORA_FIXO, ensureDefaultPresenterCommissionTiers, presenterFixedSql } from '../config/presenter_defaults.js'
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

const imageUrlSchema = z.string().max(500000).nullable().optional()

const convidarSchema = z.object({
  nome: z.string().min(2),
  email: z.string().email(),
  papel: z.enum([
    'gerente', 'gerente_comercial', 'financeiro', 'operacional',
    'apresentador', 'apresentadora', 'cliente_parceiro',
  ]),
  cliente_id: z.string().uuid().optional(),
  apresentadora_id: z.string().uuid().optional(),
  fixo: z.number().nonnegative().max(MAX_APRESENTADORA_FIXO, `Fixo não pode ultrapassar R$ ${MAX_APRESENTADORA_FIXO.toLocaleString('pt-BR')}`).optional(),
  comissao_pct: z.number().min(0).max(100).optional(),
  meta_diaria_gmv: z.number().nonnegative().optional(),
  foto_url: imageUrlSchema,
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

function isPresenterRole(papel) {
  return papel === 'apresentador' || papel === 'apresentadora'
}

export async function usuariosRoutes(app) {
  const rbac = [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master'])]

  // GET /v1/usuarios?papel=...&ativo=...
  app.get('/v1/usuarios', { preHandler: rbac }, async (request, reply) => {
    const { papel, ativo } = request.query
    const conditions = ['u.tenant_id = $1', 'u.id != $2']
    const values = [request.user.tenant_id, request.user.sub]
    let idx = 3

    if (papel) {
      conditions.push(`u.papel = $${idx++}`)
      values.push(papel)
    }
    // Default: exclui ativo=false (soft-delete leakage fix).
    // ?ativo=true|false → filtra exato; ?include_inactive=true → bypass.
    const includeInactive = String(request.query?.include_inactive ?? '').toLowerCase() === 'true'
    if (ativo !== undefined) {
      conditions.push(`u.ativo = $${idx++}`)
      values.push(ativo === 'true')
    } else if (!includeInactive) {
      conditions.push('u.ativo IS NOT FALSE')
    }

    return app.withTenant(request.user.tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
           u.id,
           u.nome,
           u.email,
           u.papel,
           u.ativo,
           u.criado_em,
           u.criado_por,
           a.id AS apresentadora_id,
           a.telefone,
           a.cidade,
           CASE
             WHEN a.id IS NOT NULL OR u.papel IN ('apresentador', 'apresentadora')
             THEN ${presenterFixedSql('a')}
             ELSE a.fixo
           END AS fixo,
           a.comissao_pct,
           a.meta_diaria_gmv,
           a.foto_url,
           (a.id IS NOT NULL OR u.papel IN ('apresentador', 'apresentadora')) AS pode_apresentar_live
         FROM users u
         LEFT JOIN apresentadoras a ON a.user_id = u.id AND a.tenant_id = u.tenant_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY u.criado_em DESC`,
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
    const { nome, email, papel, cliente_id, apresentadora_id, fixo, comissao_pct, meta_diaria_gmv, foto_url, senha_temporaria } = parsed.data
    const tenantId = request.user.tenant_id
    const presenterFixo = fixo ?? DEFAULT_APRESENTADORA_FIXO
    const presenterComissaoPct = comissao_pct ?? 0

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

        let apresentadoraId = null
        if (isPresenterRole(papel)) {
          if (apresentadora_id) {
            const linked = await db.query(
              `UPDATE apresentadoras
                  SET user_id = $1,
                      nome = $4,
                      email = $5,
                      fixo = $6,
                      comissao_pct = $7,
                      meta_diaria_gmv = COALESCE($8, meta_diaria_gmv),
                      foto_url = COALESCE($9, foto_url),
                      ativo = true
                WHERE id = $2
                  AND tenant_id = $3
                  AND user_id IS NULL
                RETURNING id`,
              [newUser.id, apresentadora_id, tenantId, nome, email, presenterFixo, presenterComissaoPct, meta_diaria_gmv ?? null, foto_url ?? null]
            )
            if (linked.rowCount === 0) {
              await db.query('ROLLBACK')
              return reply.code(409).send({ error: 'Perfil de apresentadora indisponível para vínculo.' })
            }
            apresentadoraId = linked.rows[0].id
            await ensureDefaultPresenterCommissionTiers(db, tenantId, apresentadoraId)
          } else {
            const createdProfile = await db.query(
              `INSERT INTO apresentadoras (tenant_id, user_id, nome, email, fixo, comissao_pct, meta_diaria_gmv, foto_url, ativo)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
               RETURNING id`,
              [tenantId, newUser.id, nome, email, presenterFixo, presenterComissaoPct, meta_diaria_gmv ?? 0, foto_url ?? null]
            )
            apresentadoraId = createdProfile.rows[0]?.id ?? null
            await ensureDefaultPresenterCommissionTiers(db, tenantId, apresentadoraId)
          }
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

          app.audit?.log?.(request, { action: 'usuarios.invite', entity_type: 'user', entity_id: newUser.id, metadata: { email, papel } })?.catch(err => app.log.error({ err }, 'audit log failed'))

          reply.header('Cache-Control', 'no-store')
          reply.header('Pragma', 'no-cache')
          return reply.code(201).send({
            ...newUser,
            apresentadora_id: apresentadoraId,
            pode_apresentar_live: isPresenterRole(papel),
            invite_enviado: true,
            invite_expira_em: inviteExpiraEm,
          })
        }

        // Fallback legado — sem mailer ou senha forçada pelo caller.
        // S-10: resposta contém senha — proibir cache em proxies/CDN.
        app.audit?.log?.(request, { action: 'usuarios.invite', entity_type: 'user', entity_id: newUser.id, metadata: { email, papel, invite_flow: false } })?.catch(err => app.log.error({ err }, 'audit log failed'))

        reply.header('Cache-Control', 'no-store')
        reply.header('Pragma', 'no-cache')
        return reply.code(201).send({
          ...newUser,
          apresentadora_id: apresentadoraId,
          pode_apresentar_live: isPresenterRole(papel),
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

      // Captura papel atual antes do UPDATE (para audit de role_change)
      let oldPapel = null
      if (fields.papel !== undefined) {
        const oldUser = await db.query(`SELECT papel FROM users WHERE id = $1`, [request.params.id])
        oldPapel = oldUser.rows[0]?.papel ?? null
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

      if (fields.papel !== undefined && oldPapel !== null) {
        app.audit?.log?.(request, { action: 'usuarios.role_change', entity_type: 'user', entity_id: request.params.id, metadata: { old_papel: oldPapel, new_papel: fields.papel } })?.catch(err => app.log.error({ err }, 'audit log failed'))
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
      app.audit?.log?.(request, { action: 'usuarios.reset_password', entity_type: 'user', entity_id: request.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
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
      app.audit?.log?.(request, { action: 'usuarios.force_logout', entity_type: 'user', entity_id: request.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return { ok: true, token_version: result.rows[0].token_version }
    })
  })

  // POST /v1/usuarios/:id/reenviar-convite
  // Reenviar convite para usuário que ainda não aceitou (primeiro_acesso = false)
  app.post('/v1/usuarios/:id/reenviar-convite', { preHandler: rbac }, async (request, reply) => {
    return app.withTenant(request.user.tenant_id, async (db) => {
      // Validar que usuário existe e ainda não aceitou convite
      const user = await db.query(
        `SELECT id, nome, email, primeiro_acesso FROM users
         WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, request.user.tenant_id]
      )
      if (user.rows.length === 0) {
        return reply.code(404).send({ error: 'Usuário não encontrado' })
      }
      const userData = user.rows[0]
      if (userData.primeiro_acesso === true) {
        return reply.code(400).send({ error: 'Usuário já aceitou convite ou não pode receber novo convite' })
      }

      // Gerar novo invite_token e atualizar expiração
      const inviteRawToken = crypto.randomBytes(32).toString('hex')
      const inviteTokenHash = crypto.createHash('sha256').update(inviteRawToken).digest('hex')
      const inviteExpiraEm = new Date(Date.now() + 72 * 60 * 60 * 1000)

      const result = await db.query(
        `UPDATE users SET invite_token_hash = $1, invite_expira_em = $2, atualizado_em = NOW()
         WHERE id = $3 AND tenant_id = $4
         RETURNING id, nome, email`,
        [inviteTokenHash, inviteExpiraEm, request.params.id, request.user.tenant_id]
      )

      // Disparar email de convite (fire-and-forget)
      const inviteUrl = `${_frontendUrl()}/aceitar-convite?token=${encodeURIComponent(inviteRawToken)}`
      notify('convite_usuario', {
        usuario_nome: result.rows[0].nome,
        usuario_email: result.rows[0].email,
        invite_url: inviteUrl,
        expira_em: inviteExpiraEm.toLocaleString('pt-BR'),
      }).catch(err => app.log.error({ err }, 'Failed to send invite email'))

      app.audit?.log?.(request, { action: 'usuarios.invite_resend', entity_type: 'user', entity_id: request.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return { ok: true, invite_enviado: true }
    })
  })

  // GET /v1/usuarios/convites-pendentes
  // Lista usuários que receberam convite mas ainda não aceitaram (primeiro_acesso = false)
  app.get('/v1/usuarios/convites-pendentes', { preHandler: rbac }, async (request, reply) => {
    return app.withTenant(request.user.tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
           u.id, u.nome, u.email, u.papel, u.criado_em,
           u.invite_expira_em,
           (u.invite_expira_em IS NOT NULL AND u.invite_expira_em < NOW()) AS expirou,
           CASE
             WHEN u.invite_expira_em IS NULL THEN NULL
             WHEN u.invite_expira_em < NOW() THEN 0
             ELSE GREATEST(0, EXTRACT(EPOCH FROM (u.invite_expira_em - NOW())) / 86400)::int
           END AS dias_restantes,
           c.nome AS convidado_por_nome
         FROM users u
         LEFT JOIN users c ON c.id = u.criado_por AND c.tenant_id = u.tenant_id
         WHERE u.tenant_id = $1
           AND u.invite_token_hash IS NOT NULL
           AND u.primeiro_acesso = false
           AND u.ativo = true
         ORDER BY u.invite_expira_em ASC NULLS LAST`,
        [request.user.tenant_id]
      )
      return result.rows
    })
  })

  // POST /v1/usuarios/convites/reenviar-bulk
  // Reenviar convite em lote. Max 50 ids por chamada (anti DoS).
  app.post('/v1/usuarios/convites/reenviar-bulk', { preHandler: rbac }, async (request, reply) => {
    const { ids } = request.body ?? {}
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: 'ids deve ser um array não vazio' })
    }
    if (ids.length > 50) {
      return reply.code(400).send({ error: 'Máximo 50 convites por chamada' })
    }
    // Validar que todos são UUIDs básicos
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!ids.every(id => typeof id === 'string' && uuidRegex.test(id))) {
      return reply.code(400).send({ error: 'ids inválidos — use UUIDs' })
    }

    const reenviados = []
    const falhas = []

    for (const id of ids) {
      try {
        await app.withTenant(request.user.tenant_id, async (db) => {
          const user = await db.query(
            `SELECT id, nome, email, primeiro_acesso
             FROM users
             WHERE id = $1 AND tenant_id = $2`,
            [id, request.user.tenant_id]
          )
          if (user.rows.length === 0) {
            throw new Error('Usuário não encontrado')
          }
          if (user.rows[0].primeiro_acesso === true) {
            throw new Error('Usuário já aceitou o convite')
          }

          const inviteRawToken = crypto.randomBytes(32).toString('hex')
          const inviteTokenHash = crypto.createHash('sha256').update(inviteRawToken).digest('hex')
          const inviteExpiraEm = new Date(Date.now() + 72 * 60 * 60 * 1000)

          await db.query(
            `UPDATE users SET invite_token_hash = $1, invite_expira_em = $2, atualizado_em = NOW()
             WHERE id = $3 AND tenant_id = $4`,
            [inviteTokenHash, inviteExpiraEm, id, request.user.tenant_id]
          )

          const inviteUrl = `${_frontendUrl()}/aceitar-convite?token=${encodeURIComponent(inviteRawToken)}`
          notify('convite_usuario', {
            usuario_nome: user.rows[0].nome,
            usuario_email: user.rows[0].email,
            invite_url: inviteUrl,
            expira_em: inviteExpiraEm.toLocaleString('pt-BR'),
          }).catch(err => app.log.error({ err }, 'Failed to send bulk invite email'))

          app.audit?.log?.(request, { action: 'usuarios.invite_resend_bulk', entity_type: 'user', entity_id: id })?.catch(err => app.log.error({ err }, 'audit log failed'))
          reenviados.push(id)
        })
      } catch (err) {
        falhas.push({ id, erro: err.message ?? 'Erro desconhecido' })
      }
    }

    return { reenviados: reenviados.length, falhas }
  })

  // DELETE /v1/usuarios/convites/:id
  // Cancela convite — deleta user que nunca aceitou (primeiro_acesso = false)
  app.delete('/v1/usuarios/convites/:id', { preHandler: rbac }, async (request, reply) => {
    if (request.params.id === request.user.sub) {
      return reply.code(400).send({ error: 'Não é possível cancelar o próprio convite' })
    }

    return app.withTenant(request.user.tenant_id, async (db) => {
      // Verificar que o usuário existe, pertence ao tenant e nunca aceitou
      const user = await db.query(
        `SELECT id, primeiro_acesso FROM users
         WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, request.user.tenant_id]
      )
      if (user.rows.length === 0) {
        return reply.code(404).send({ error: 'Usuário não encontrado' })
      }
      if (user.rows[0].primeiro_acesso === true) {
        return reply.code(400).send({ error: 'Não é possível cancelar convite de usuário que já aceitou' })
      }

      // Limpar tokens antes de deletar
      await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [request.params.id])
      await db.query(
        'DELETE FROM users WHERE id = $1 AND tenant_id = $2',
        [request.params.id, request.user.tenant_id]
      )

      app.audit?.log?.(request, { action: 'usuarios.invite_cancel', entity_type: 'user', entity_id: request.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return reply.code(204).send()
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
      app.audit?.log?.(request, { action: 'usuarios.delete', entity_type: 'user', entity_id: request.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return reply.code(204).send()
    })
  })
}
