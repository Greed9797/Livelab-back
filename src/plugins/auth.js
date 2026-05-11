import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import * as Sentry from '@sentry/node'

async function authPlugin(app) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET deve ter no mínimo 32 caracteres')
  }

  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: {
      algorithm: 'HS256',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    },
    verify: {
      algorithms: ['HS256'],
    },
  })

  // Helper: valida que JWT.token_version está atualizado vs DB.
  // Se DB.token_version > JWT.token_version, o JWT foi invalidado por
  // /redefinir-senha ou /usuarios/:id/force-logout — retorna 401.
  //
  // Tolerante a falhas: se a query falhar (db down) ou o user não existir,
  // não bloqueia (cai pra comportamento atual). Se token_version não estiver
  // no payload (JWT antigo emitido antes do deploy), trata como version 1
  // (compatibilidade durante rollout — JWTs anteriores expiram em 15min).
  async function _verifyTokenVersion(request, reply) {
    const userId = request.user?.sub
    if (!userId) return // sem sub: outros checks vão recusar
    const jwtVersion = Number.isInteger(request.user?.token_version)
      ? request.user.token_version
      : 1
    try {
      const { rows } = await app.db.query(
        `SELECT token_version FROM users WHERE id = $1`,
        [userId]
      )
      const dbVersion = rows[0]?.token_version ?? jwtVersion
      if (dbVersion > jwtVersion) {
        return reply.code(401).send({ error: 'Sessão expirada' })
      }
    } catch (err) {
      app.log.warn({ err }, 'token_version check falhou — permitindo (fail-open)')
    }
  }

  // preHandler reutilizável: app.authenticate
  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify()
    } catch (err) {
      app.log.warn({ msg: err.message, code: err.code }, 'JWT verification failed')
      return reply.code(401).send({ error: 'Token inválido ou expirado' })
    }
    // Sentry breadcrumb — observabilidade sem PII (apenas user_id e papel)
    if (process.env.SENTRY_DSN) {
      try {
        Sentry.addBreadcrumb({
          category: 'auth',
          message: 'authenticated',
          level: 'info',
          data: { user_id: request.user?.sub, papel: request.user?.papel },
        })
      } catch {
        // breadcrumb nunca pode quebrar fluxo
      }
    }
    return _verifyTokenVersion(request, reply)
  })

  // preHandler: verifica papel específico
  app.decorate('requirePapel', (requiredPapeis) => async (request, reply) => {
    const papeis = Array.isArray(requiredPapeis) ? requiredPapeis : [requiredPapeis]

    // S-04: SEMPRE valida JWT — nunca confia em request.user pré-existente
    // (evita bypass se outro plugin popular request.user antes).
    try {
      await request.jwtVerify()
    } catch {
      return reply.code(401).send({ error: 'Não autenticado' })
    }

    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
    }

    return _verifyTokenVersion(request, reply)
  })

  // preHandler para rotas /v1/master/* compartilhadas entre franqueador_master
  // e gerente_regional. Injeta:
  //   request.isMaster: boolean       (true = franqueador_master)
  //   request.allowedTenantIds: string[]  (lista pra filtro SQL; vazia se
  //                                        gerente_regional sem acesso)
  //
  // Decisão: SEMPRE consulta o banco a cada request — nunca confia em claims
  // do JWT. Assim, revogar acesso tem efeito imediato (sem esperar exp do
  // token de 15min). Se virar gargalo, cachear em Redis com invalidação por
  // tenant_id, mas hoje 1 SELECT por request /v1/master/* é negligenciável.
  app.decorate('requireTenantAccess', async (request, reply) => {
    // jwtVerify já é assumido (rota usa também app.authenticate ou
    // requirePapel antes) — mas chamamos defensivamente.
    if (!request.user) {
      try {
        await request.jwtVerify()
      } catch {
        return reply.code(401).send({ error: 'Não autenticado' })
      }
    }

    const papel = request.user.papel
    if (papel === 'franqueador_master') {
      request.isMaster = true
      request.allowedTenantIds = null // null = sem restrição = vê tudo
      return
    }

    if (papel === 'gerente_regional') {
      try {
        const { rows } = await app.db.query(
          `SELECT tenant_id FROM user_tenant_access WHERE user_id = $1`,
          [request.user.sub ?? request.user.id]
        )
        request.isMaster = false
        request.allowedTenantIds = rows.map((r) => r.tenant_id)
        return
      } catch (err) {
        request.log.error({ err }, 'requireTenantAccess: falha consulta user_tenant_access')
        return reply.code(500).send({ error: 'Falha verificando permissões' })
      }
    }

    return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
  })
}

export default fp(authPlugin, { name: 'auth', dependencies: ['db'] })
export { authPlugin }
