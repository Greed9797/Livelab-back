import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import {
  loginSchema,
  refreshSchema,
  esqueciSenhaSchema,
  redefinirSenhaSchema,
  aceitarConviteSchema,
} from '../schemas/auth.schema.js'
import { SECURITY } from '../config/security.js'
import { notify } from '../services/mailer.js'

const _frontendUrl = () =>
  (process.env.FRONTEND_URL ?? 'https://livelab-3601f.web.app').replace(/\/+$/, '')

const _hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex')

export async function authRoutes(app) {
  const isProd = process.env.NODE_ENV === 'production'

  // POST /v1/auth/login — rate limited: 5/min em produção, 100/min em dev/test
  app.post('/v1/auth/login', { config: { rateLimit: { max: isProd ? 5 : 100, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const { email, senha } = parsed.data

    const result = await app.db.query(
      `SELECT u.*, t.nome as tenant_nome
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 AND u.ativo = true`,
      [email]
    )

    const user = result.rows[0]
    if (!user) return reply.code(401).send({ error: 'Credenciais inválidas' })

    const senhaOk = await bcrypt.compare(senha, user.senha_hash)
    if (!senhaOk) return reply.code(401).send({ error: 'Credenciais inválidas' })

    const payload = {
      sub: user.id,
      tenant_id: user.tenant_id,
      papel: user.papel,
      nome: user.nome,
      email: user.email,
      onboarding_completed: user.onboarding_completed ?? false,
      // Snapshot da versão atual: app.authenticate compara contra DB.
      // Se token_version no DB for incrementado (force-logout/redefinir-senha),
      // este JWT vira inválido instantaneamente.
      token_version: user.token_version ?? 1,
    }

    const accessToken = app.jwt.sign(payload)

    const rawRefresh = crypto.randomBytes(40).toString('hex')
    const refreshHash = crypto.createHash('sha256').update(rawRefresh).digest('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await app.db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expira_em)
       VALUES ($1, $2, $3)`,
      [user.id, refreshHash, expiresAt]
    )

    return {
      access_token: accessToken,
      refresh_token: rawRefresh,
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        papel: user.papel,
        tenant_id: user.tenant_id,
        tenant_nome: user.tenant_nome,
        onboarding_completed: user.onboarding_completed ?? false,
      },
    }
  })

  // POST /v1/auth/refresh — rate limited: 10/min em produção, 200/min em dev/test
  app.post('/v1/auth/refresh', { config: { rateLimit: { max: isProd ? 10 : 200, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }

    const tokenHash = crypto
      .createHash('sha256')
      .update(parsed.data.refresh_token)
      .digest('hex')

    const result = await app.db.query(
      `SELECT rt.*, u.tenant_id, u.papel, u.nome, u.email, u.ativo, u.onboarding_completed,
              u.token_version
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1
         AND rt.revogado = false
         AND rt.expira_em > NOW()`,
      [tokenHash]
    )

    const rt = result.rows[0]
    if (!rt) return reply.code(401).send({ error: 'Refresh token inválido ou expirado' })
    if (!rt.ativo) return reply.code(401).send({ error: 'Usuário inativo' })

    // Revogar o token usado (rotação — previne reuso após comprometimento)
    await app.db.query(
      `UPDATE refresh_tokens SET revogado = true WHERE id = $1`,
      [rt.id]
    )

    const accessToken = app.jwt.sign({
      sub: rt.user_id,
      tenant_id: rt.tenant_id,
      papel: rt.papel,
      nome: rt.nome,
      email: rt.email,
      onboarding_completed: rt.onboarding_completed ?? false,
      token_version: rt.token_version ?? 1,
    })

    // Emitir novo refresh token
    const newRawRefresh = crypto.randomBytes(40).toString('hex')
    const newRefreshHash = crypto.createHash('sha256').update(newRawRefresh).digest('hex')
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await app.db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expira_em) VALUES ($1, $2, $3)`,
      [rt.user_id, newRefreshHash, newExpiresAt]
    )

    return { access_token: accessToken, refresh_token: newRawRefresh }
  })

  // POST /v1/auth/logout
  app.post('/v1/auth/logout', {
    preHandler: app.authenticate,
  }, async (request, reply) => {
    await app.db.query(
      `UPDATE refresh_tokens SET revogado = true WHERE user_id = $1`,
      [request.user.sub]
    )
    return { ok: true }
  })

  // PATCH /v1/auth/senha — usuário autenticado troca a própria senha
  app.patch('/v1/auth/senha', { preHandler: app.authenticate }, async (request, reply) => {
    const { senha_atual, nova_senha } = request.body ?? {}
    if (typeof senha_atual !== 'string' || senha_atual.length < 1) {
      return reply.code(400).send({ error: 'senha_atual é obrigatória' })
    }
    if (typeof nova_senha !== 'string' || !SECURITY.PASSWORD_REGEX.test(nova_senha)) {
      return reply.code(400).send({ error: SECURITY.PASSWORD_HINT })
    }

    const userResult = await app.db.query(
      `SELECT id, senha_hash FROM users WHERE id = $1 AND ativo = true`,
      [request.user.sub]
    )
    const user = userResult.rows[0]
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado' })

    const senhaOk = await bcrypt.compare(senha_atual, user.senha_hash)
    if (!senhaOk) return reply.code(401).send({ error: 'Senha atual incorreta' })

    const novoHash = await bcrypt.hash(nova_senha, SECURITY.BCRYPT_ROUNDS)
    await app.db.query(
      `UPDATE users SET senha_hash = $1, atualizado_em = NOW() WHERE id = $2`,
      [novoHash, user.id]
    )

    // Revoga refresh tokens existentes — força re-login em outras sessões
    await app.db.query(
      `UPDATE refresh_tokens SET revogado = true WHERE user_id = $1`,
      [user.id]
    )

    return { ok: true }
  })

  // ─────────────────────────────────────────────────────────────────
  // F4: Recuperação de senha
  // ─────────────────────────────────────────────────────────────────

  // POST /v1/auth/esqueci-senha — sempre retorna 200 (anti-enumeração)
  // Rate limit: 3/h por IP em prod, 100/h em dev. Limite extra por email
  // (no_op silencioso) aplicado no handler.
  app.post(
    '/v1/auth/esqueci-senha',
    {
      config: {
        rateLimit: { max: isProd ? 3 : 100, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      // Resposta padrão genérica — usada em TODOS os caminhos pra não vazar
      // diferença entre "email existe" / "email não existe" / "rate-limit por
      // email atingido". Mensagem é a mesma e o tempo de resposta é dominado
      // pelo bcrypt.compare faked abaixo quando não acha o user.
      const genericResponse = {
        ok: true,
        message:
          'Se este email estiver cadastrado, você receberá o link em breve.',
      }

      // Headers de privacidade — link nunca deve sair pelo Referer.
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('Cache-Control', 'no-store')

      const parsed = esqueciSenhaSchema.safeParse(request.body)
      if (!parsed.success) {
        // Mesma resposta de sucesso pra não vazar formato esperado.
        return reply.code(200).send(genericResponse)
      }
      const { email } = parsed.data
      const ip = request.ip ?? null

      try {
        const userResult = await app.db.query(
          `SELECT id, nome, email, tenant_id
             FROM users
            WHERE LOWER(email) = LOWER($1) AND ativo = true
            LIMIT 1`,
          [email]
        )
        const user = userResult.rows[0]

        if (!user) {
          // Equaliza tempo de resposta — bcrypt faked pra não revelar inexistência.
          await bcrypt.compare(
            'fake-password-for-timing-equalization',
            '$2b$12$abcdefghijklmnopqrstuv1234567890abcdefghijklmnopqrstuv'
          )
          return reply.code(200).send(genericResponse)
        }

        // Rate-limit por email — máx 3 tokens ativos na última hora.
        // Evita bypass do rate-limit por IP via VPN/proxy.
        const activeCount = await app.db.query(
          `SELECT COUNT(*)::int AS n
             FROM password_reset_tokens
            WHERE user_id = $1
              AND criado_em > NOW() - INTERVAL '1 hour'`,
          [user.id]
        )
        if ((activeCount.rows[0]?.n ?? 0) >= 3) {
          // Silencioso — não envia novo email mas resposta é a mesma.
          return reply.code(200).send(genericResponse)
        }

        // Invalida tokens anteriores deste user (link reuse defense).
        await app.db.query(
          `UPDATE password_reset_tokens
              SET usado_em = NOW()
            WHERE user_id = $1 AND usado_em IS NULL`,
          [user.id]
        )

        const rawToken = crypto.randomBytes(32).toString('hex')
        const tokenHash = _hashToken(rawToken)
        const expiraEm = new Date(Date.now() + 60 * 60 * 1000) // 1h

        await app.db.query(
          `INSERT INTO password_reset_tokens
             (user_id, token_hash, expira_em, ip_solicitacao)
           VALUES ($1, $2, $3, $4)`,
          [user.id, tokenHash, expiraEm, ip]
        )

        const link = `${_frontendUrl()}/redefinir-senha?token=${rawToken}`

        // Fire-and-forget — não esperamos o email pra responder.
        notify({
          app,
          tenantId: user.tenant_id,
          to: user.email,
          template: 'recuperacao_senha',
          vars: { nome: user.nome, link },
        }).catch((err) => {
          app.log?.warn?.({ err }, '[auth] falha ao enviar email recuperacao_senha')
        })

        return reply.code(200).send(genericResponse)
      } catch (err) {
        app.log?.error?.({ err }, '[auth] erro em /esqueci-senha')
        // Não vazar erro interno — resposta genérica.
        return reply.code(200).send(genericResponse)
      }
    }
  )

  // POST /v1/auth/redefinir-senha
  app.post(
    '/v1/auth/redefinir-senha',
    {
      config: {
        rateLimit: { max: isProd ? 10 : 200, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('Cache-Control', 'no-store')

      const parsed = redefinirSenhaSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message })
      }
      const { token, nova_senha } = parsed.data

      if (!SECURITY.PASSWORD_REGEX.test(nova_senha)) {
        return reply.code(400).send({ error: SECURITY.PASSWORD_HINT })
      }

      const tokenHash = _hashToken(token)

      // CONSUMO ATÔMICO — UPDATE...RETURNING evita race condition.
      // Se 2 requests chegam ao mesmo tempo, apenas 1 marca usado_em e ganha
      // o user_id. A outra retorna rowCount=0 → erro "link inválido".
      const consumed = await app.db.query(
        `UPDATE password_reset_tokens
            SET usado_em = NOW()
          WHERE token_hash = $1
            AND usado_em IS NULL
            AND expira_em > NOW()
          RETURNING user_id`,
        [tokenHash]
      )
      if (consumed.rowCount === 0) {
        return reply.code(400).send({ error: 'Link inválido ou expirado' })
      }
      const userId = consumed.rows[0].user_id

      const novoHash = await bcrypt.hash(nova_senha, SECURITY.BCRYPT_ROUNDS)

      // Atualiza senha + INCREMENTA token_version no mesmo statement.
      // O bump invalida instantaneamente quaisquer JWTs (access tokens, 15min)
      // emitidos antes do reset — fecha a janela de exposição que sobrava
      // mesmo após revogar refresh_tokens (apenas access tokens precisariam
      // expirar pelo TTL).
      await app.db.query(
        `UPDATE users
            SET senha_hash = $1,
                token_version = token_version + 1,
                atualizado_em = NOW()
          WHERE id = $2 AND ativo = true`,
        [novoHash, userId]
      )

      // Revoga TODAS as sessões existentes — força re-login.
      // Mitiga session fixation: se a senha vazou, todas as sessões antigas
      // (incluindo do atacante) ficam inválidas.
      await app.db.query(
        `UPDATE refresh_tokens SET revogado = true WHERE user_id = $1`,
        [userId]
      )

      return { ok: true }
    }
  )

  // POST /v1/auth/aceitar-convite — auto-login após definir senha
  app.post(
    '/v1/auth/aceitar-convite',
    {
      config: {
        rateLimit: { max: isProd ? 10 : 200, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('Cache-Control', 'no-store')

      const parsed = aceitarConviteSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message })
      }
      const { token, nova_senha } = parsed.data

      if (!SECURITY.PASSWORD_REGEX.test(nova_senha)) {
        return reply.code(400).send({ error: SECURITY.PASSWORD_HINT })
      }

      const tokenHash = _hashToken(token)
      const novoHash = await bcrypt.hash(nova_senha, SECURITY.BCRYPT_ROUNDS)

      // Consumo atômico do convite.
      // Bloqueio anti account-takeover: primeiro_acesso = false garante que
      // um link de convite antigo NÃO pode ser reusado para roubar a conta
      // depois que o usuário já ativou.
      const consumed = await app.db.query(
        `UPDATE users
            SET senha_hash = $1,
                invite_token_hash = NULL,
                invite_expira_em = NULL,
                primeiro_acesso = true,
                atualizado_em = NOW()
          WHERE invite_token_hash = $2
            AND invite_expira_em > NOW()
            AND primeiro_acesso = false
            AND ativo = true
          RETURNING id, tenant_id, papel, nome, email, onboarding_completed, token_version`,
        [novoHash, tokenHash]
      )

      if (consumed.rowCount === 0) {
        return reply.code(400).send({ error: 'Convite inválido ou expirado' })
      }

      const user = consumed.rows[0]

      // Pega tenant_nome pra payload do JWT.
      const tenantResult = await app.db.query(
        `SELECT nome FROM tenants WHERE id = $1`,
        [user.tenant_id]
      )
      const tenantNome = tenantResult.rows[0]?.nome ?? null

      // Auto-login: emite tokens igual ao /login.
      // aceitar-convite NÃO incrementa token_version (primeiro acesso, sem
      // sessões prévias pra invalidar — manteria o JWT recém-emitido inválido
      // contra ele mesmo).
      const accessToken = app.jwt.sign({
        sub: user.id,
        tenant_id: user.tenant_id,
        papel: user.papel,
        nome: user.nome,
        email: user.email,
        onboarding_completed: user.onboarding_completed ?? false,
        token_version: user.token_version ?? 1,
      })

      const rawRefresh = crypto.randomBytes(40).toString('hex')
      const refreshHash = crypto
        .createHash('sha256')
        .update(rawRefresh)
        .digest('hex')
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      await app.db.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expira_em)
         VALUES ($1, $2, $3)`,
        [user.id, refreshHash, expiresAt]
      )

      return {
        access_token: accessToken,
        refresh_token: rawRefresh,
        user: {
          id: user.id,
          nome: user.nome,
          email: user.email,
          papel: user.papel,
          tenant_id: user.tenant_id,
          tenant_nome: tenantNome,
          onboarding_completed: user.onboarding_completed ?? false,
        },
      }
    }
  )
}
