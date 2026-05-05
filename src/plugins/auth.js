import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'

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

  // preHandler reutilizável: app.authenticate
  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify()
    } catch (err) {
      app.log.warn({ msg: err.message, code: err.code }, 'JWT verification failed')
      return reply.code(401).send({ error: 'Token inválido ou expirado' })
    }
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
  })
}

export default fp(authPlugin, { name: 'auth', dependencies: ['db'] })
export { authPlugin }
