import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import { loginSchema, refreshSchema } from '../schemas/auth.schema.js'
import { SECURITY } from '../config/security.js'

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
      `SELECT rt.*, u.tenant_id, u.papel, u.nome, u.email, u.ativo, u.onboarding_completed
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
}
