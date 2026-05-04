import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import { dbPlugin } from './plugins/db.js'
import { authPlugin } from './plugins/auth.js'
import { authRoutes } from './routes/auth.js'
import { homeRoutes } from './routes/home.js'
import { analyticsRoutes } from './routes/analytics.js'
import { clientesRoutes } from './routes/clientes.js'
import { contratosRoutes } from './routes/contratos.js'
import { financeiroRoutes } from './routes/financeiro.js'
import { cabinesRoutes } from './routes/cabines.js'
import { clienteDashboardRoutes } from './routes/cliente_dashboard.js'
import { leadsRoutes } from './routes/leads.js'
import { boletosRoutes } from './routes/boletos.js'
import { excelenciaRoutes } from './routes/excelencia.js'
import { recomendacoesRoutes } from './routes/recomendacoes.js'
import { franqueadoRoutes } from './routes/franqueado.js'
import { manuaisRoutes } from './routes/manuais.js'
import { tiktokRoutes } from './routes/tiktok.js'
import { cepRoutes } from './routes/cep.js'
import { configuracoesRoutes } from './routes/configuracoes.js'
import { solicitacoesRoutes } from './routes/solicitacoes.js'
import { pacotesRoutes } from './routes/pacotes.js'
import { usuariosRoutes } from './routes/usuarios.js'
import { apresentadorasRoutes } from './routes/apresentadoras.js'
import { liveApresentadoresRoutes } from './routes/live_apresentadores.js'
import { clientePortalRoutes } from './routes/cliente_portal.js'
import onboardingRoutes from './routes/onboarding.js'
import { tenantsRoutes } from './routes/tenants.js'
import { webhookBioCrmRoutes } from './routes/webhook_bio_crm.js'

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    ...opts,
  })

  const corsAllowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : (process.env.NODE_ENV === 'production'
        ? ['https://livelab-3601f.web.app', 'https://livelab-3601f.firebaseapp.com']
        : null)

  const TIKTOK_ORIGINS = [
    'https://developers.tiktok.com',
    'https://business.tiktok.com',
    'https://open.tiktokapis.com',
    'https://open-api.tiktok.com',
  ]

  await app.register(cors, {
    origin: (origin, cb) => {
      // Sem Origin = server-to-server (webhooks) → sempre permitir
      if (!origin) return cb(null, true)
      // Dev → permitir tudo
      if (!corsAllowedOrigins) return cb(null, true)
      // TikTok portals → sempre permitir (webhooks e OAuth callback)
      if (TIKTOK_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true)
      // App Firebase → permitir
      if (corsAllowedOrigins.includes(origin)) return cb(null, true)
      cb(new Error('Not allowed by CORS'))
    },
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'tiktok-signature'],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  })
  // Security headers (CSP disabled — TikTok callback returns text/html)
  await app.register(helmet, { contentSecurityPolicy: false })
  // Global rate limiting (100 req/min default; auth routes override with stricter limits)
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: 'Muitas requisições. Tente novamente em breve.' }),
  })
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } })

  // Captura rawBody em JSON pra validação HMAC de webhooks (bio-crm, tiktok).
  // Não muda comportamento de request.body — só anexa request.rawBody.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body
    if (body === '' || body === null) return done(null, {})
    try {
      done(null, JSON.parse(body))
    } catch (err) {
      err.statusCode = 400
      done(err, undefined)
    }
  })

  await app.register(dbPlugin)
  await app.register(authPlugin)

  await app.register(authRoutes)
  await app.register(homeRoutes)
  await app.register(analyticsRoutes)
  await app.register(clientesRoutes)
  await app.register(contratosRoutes)
  await app.register(financeiroRoutes)
  await app.register(cabinesRoutes)
  await app.register(clienteDashboardRoutes)
  await app.register(leadsRoutes)
  await app.register(boletosRoutes)
  await app.register(excelenciaRoutes)
  await app.register(recomendacoesRoutes)
  await app.register(franqueadoRoutes)
  await app.register(manuaisRoutes)
  await app.register(tiktokRoutes)
  await app.register(cepRoutes)
  await app.register(configuracoesRoutes)
  await app.register(solicitacoesRoutes)
  await app.register(pacotesRoutes)
  await app.register(usuariosRoutes)
  await app.register(apresentadorasRoutes)
  await app.register(liveApresentadoresRoutes)
  await app.register(clientePortalRoutes)
  await app.register(onboardingRoutes)
  await app.register(tenantsRoutes)
  await app.register(webhookBioCrmRoutes)

  app.get('/health', () => ({ ok: true }))

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled error')
      return reply.code(500).send({ error: 'Erro interno do servidor' })
    }
    return reply.code(status).send({ error: error.message })
  })

  return app
}
