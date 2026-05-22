import Fastify from 'fastify'
import * as Sentry from '@sentry/node'
import { timingSafeEqual } from 'crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import { dbPlugin } from './plugins/db.js'
import { authPlugin } from './plugins/auth.js'
import { auditLogPlugin } from './plugins/audit_log.js'
import { authRoutes } from './routes/auth.js'
import { homeRoutes } from './routes/home.js'
import { analyticsRoutes } from './routes/analytics.js'
import { clientesRoutes } from './routes/clientes.js'
import { contratosRoutes } from './routes/contratos.js'
import { financeiroRoutes } from './routes/financeiro.js'
import { relatoriosRoutes } from './routes/relatorios.js'
import { cabinesRoutes } from './routes/cabines.js'
import { livesRoutes } from './routes/lives.js'
import { clienteDashboardRoutes } from './routes/cliente_dashboard.js'
import { leadsRoutes } from './routes/leads.js'
import { crmRoutes } from './routes/crm.js'
import { boletosRoutes } from './routes/boletos.js'
import { excelenciaRoutes } from './routes/excelencia.js'
import { recomendacoesRoutes } from './routes/recomendacoes.js'
import { franqueadoRoutes } from './routes/franqueado.js'
import { regionalManagersRoutes } from './routes/regional_managers.js'
import { manuaisRoutes } from './routes/manuais.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { clienteNotasRoutes } from './routes/cliente_notas.js'
import { tiktokRoutes } from './routes/tiktok.js'
import { cepRoutes } from './routes/cep.js'
import { configuracoesRoutes } from './routes/configuracoes.js'
import { solicitacoesRoutes } from './routes/solicitacoes.js'
import { pacotesRoutes } from './routes/pacotes.js'
import { usuariosRoutes } from './routes/usuarios.js'
import { apresentadorasRoutes } from './routes/apresentadoras.js'
import { apresentadoraDisponibilidadeRoutes } from './routes/apresentadora_disponibilidade.js'
import { liveApresentadoresRoutes } from './routes/live_apresentadores.js'
import { clientePortalRoutes } from './routes/cliente_portal.js'
import onboardingRoutes from './routes/onboarding.js'
import { tenantsRoutes } from './routes/tenants.js'
import { webhookBioCrmRoutes } from './routes/webhook_bio_crm.js'
import { appmaxRoutes } from './routes/appmax.js'
import { notificacoesRoutes } from './routes/notificacoes.js'
import { auditLogRoutes } from './routes/audit_log.js'
import { marcasRoutes } from './routes/marcas.js'
import { agendaRoutes } from './routes/agenda.js'
import { videosRoutes } from './routes/videos.js'
import { vendasAtribuidasRoutes } from './routes/vendas_atribuidas.js'
import { comissoesRoutes } from './routes/comissoes.js'
import { metaUnidadeRoutes } from './routes/meta_unidade.js'
import { uploadsRoutes } from './routes/uploads.js'
import { AppError } from './lib/errors.js'

// S-Sentry: inicializa o SDK uma vez, antes de qualquer handler.
// SENTRY_DSN ausente → noop silencioso (dev/test sem Sentry).
// beforeBreadcrumb filtra campos sensíveis para cumprir LGPD.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,
    beforeBreadcrumb(breadcrumb) {
      // Remove quaisquer dados sensíveis de breadcrumbs antes de enviar ao Sentry
      if (breadcrumb.data) {
        const SENSITIVE = ['senha', 'password', 'token', 'secret', 'authorization', 'cpf', 'cnpj']
        for (const key of Object.keys(breadcrumb.data)) {
          if (SENSITIVE.some(s => key.toLowerCase().includes(s))) {
            breadcrumb.data[key] = '[Filtered]'
          }
        }
      }
      return breadcrumb
    },
  })
}

export async function healthHandler(request, reply) {
  const token = process.env.HEALTH_CHECK_TOKEN
  if (token) {
    const provided = request.headers['x-health-token'] ?? ''
    const a = Buffer.from(String(provided))
    const b = Buffer.from(token)
    const ok = a.length === b.length && timingSafeEqual(a, b)
    if (!ok) return reply.code(404).send()
  }
  return {
    ok: true,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null,
  }
}

export async function buildApp(opts = {}) {
  // S-08: secrets obrigatórios em produção. Falha cedo (boot-time) em vez de
  // descobrir mid-request que o webhook está aceitando payload sem assinatura.
  if (process.env.NODE_ENV === 'production') {
    const required = {
      JWT_SECRET: process.env.JWT_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
    }
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
    if (missing.length > 0) {
      throw new Error(`[boot] env vars obrigatórias em produção ausentes: ${missing.join(', ')}`)
    }
  }

  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    // S-09: confia no header X-Forwarded-For do primeiro proxy (Railway/Render).
    // Sem isso, rate-limit aplicaria global pelo IP do edge.
    trustProxy: process.env.NODE_ENV === 'production' ? 1 : false,
    ...opts,
  })

  // LGPD/S-06: Em produção, CORS nunca usa wildcard ('*').
  // A allowlist abaixo é a fonte da verdade para origens permitidas.
  // Para adicionar uma origem nova, atualize tanto este array quanto o
  // env var CORS_ORIGIN no painel de deploy — nunca use '*'.
  const corsBase = process.env.NODE_ENV === 'production'
    ? [
        'https://app.grupolivelab.com.br',
        'https://www.grupolivelab.com.br',
        'https://grupolivelab.com.br',
        'https://livelab-3601f.web.app',
        'https://livelab-3601f.firebaseapp.com',
        'https://liveshop-saas-frontend-react-wine.vercel.app',
        'https://liveshop-saas-frontend-react.vercel.app',
      ]
    : null
  const corsEnv = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : []
  const corsAllowedOrigins = corsBase
    ? [...new Set([...corsBase, ...corsEnv])]
    : (corsEnv.length ? corsEnv : null)

  const TIKTOK_ORIGINS = [
    'https://developers.tiktok.com',
    'https://business.tiktok.com',
    'https://open.tiktokapis.com',
    'https://open-api.tiktok.com',
  ]

  await app.register(cors, {
    origin: (origin, cb) => {
      // Sem header Origin = server-to-server (webhooks, health) → permitir
      if (origin === undefined) return cb(null, true)
      // S-06: rejeita origin "null" (iframe sandbox, file://, redirects opacos)
      if (origin === 'null') return cb(new Error('Not allowed by CORS'))
      // Dev sem allowlist → só localhost/127.0.0.1, nunca tudo
      if (!corsAllowedOrigins) {
        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        return cb(isLocal ? null : new Error('Not allowed by CORS'), isLocal)
      }
      // TikTok portals → sempre permitir (webhooks e OAuth callback)
      if (TIKTOK_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true)
      // App Firebase / domínios produção → permitir se na allowlist
      if (corsAllowedOrigins.includes(origin)) return cb(null, true)
      cb(new Error('Not allowed by CORS'))
    },
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'tiktok-signature'],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  })
  // S-12: CSP habilitado globalmente; TikTok callback sobrescreve no handler.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  })
  // Global rate limiting — usa request.ip (já correto graças ao trustProxy)
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
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
  await app.register(auditLogPlugin)

  await app.register(authRoutes)
  await app.register(homeRoutes)
  await app.register(analyticsRoutes)
  await app.register(clientesRoutes)
  await app.register(contratosRoutes)
  await app.register(financeiroRoutes)
  await app.register(relatoriosRoutes)
  await app.register(cabinesRoutes)
  await app.register(livesRoutes)
  await app.register(clienteDashboardRoutes)
  await app.register(leadsRoutes)
  await app.register(crmRoutes)
  await app.register(boletosRoutes)
  await app.register(excelenciaRoutes)
  await app.register(recomendacoesRoutes)
  await app.register(franqueadoRoutes)
  await app.register(regionalManagersRoutes)
  await app.register(manuaisRoutes)
  await app.register(knowledgeRoutes)
  await app.register(clienteNotasRoutes)
  await app.register(tiktokRoutes)
  await app.register(cepRoutes)
  await app.register(configuracoesRoutes)
  await app.register(solicitacoesRoutes)
  await app.register(pacotesRoutes)
  await app.register(usuariosRoutes)
  await app.register(apresentadorasRoutes)
  await app.register(apresentadoraDisponibilidadeRoutes)
  await app.register(liveApresentadoresRoutes)
  await app.register(clientePortalRoutes)
  await app.register(onboardingRoutes)
  await app.register(tenantsRoutes)
  await app.register(webhookBioCrmRoutes)
  await app.register(appmaxRoutes)
  await app.register(notificacoesRoutes)
  await app.register(auditLogRoutes)
  await app.register(marcasRoutes)
  await app.register(agendaRoutes)
  await app.register(videosRoutes)
  await app.register(vendasAtribuidasRoutes)
  await app.register(comissoesRoutes)
  await app.register(metaUnidadeRoutes)
  await app.register(uploadsRoutes)

  // S-11: opcional — se HEALTH_CHECK_TOKEN setado, exige header pra responder.
  // 404 (não 401) pra não confirmar existência do endpoint a scanners.
  app.get('/health', healthHandler)
  app.get('/healthcheck', healthHandler)

  app.setErrorHandler((error, request, reply) => {
    // Custom AppError subclasses: usa statusCode/sentryTag/reportable da classe
    const isAppError = error instanceof AppError
    const status = isAppError ? error.statusCode : (error.statusCode ?? 500)
    const shouldReport = status >= 500 || (isAppError && error.reportable === true)

    // LGPD: errorContext inclui APENAS metadados não-sensíveis (tenant, papel, request_id).
    // request.body NUNCA é logado — pode conter password, token, cpf, dados pessoais.
    const errorContext = {
      err: error,
      request_id: request.id,
      tenant_id: request.user?.tenant_id,
      papel: request.user?.papel,
      sentryTag: isAppError ? error.sentryTag : undefined,
    }

    if (status >= 500) {
      request.log.error(errorContext, 'Unhandled error')
    } else if (isAppError && error.reportable) {
      request.log.warn(errorContext, 'Reportable AppError')
    }

    if (shouldReport && process.env.SENTRY_DSN) {
      Sentry.withScope((scope) => {
        scope.setTag('route', request.routeOptions?.url ?? request.url)
        scope.setTag('method', request.method)
        scope.setTag('request_id', request.id)
        if (request.user?.tenant_id) scope.setTag('tenant_id', String(request.user.tenant_id))
        if (isAppError) scope.setTag('error_class', error.sentryTag)
        // Inclui dados do usuário APENAS se autenticado; email/nome são úteis
        // para triagem no Sentry mas nunca expostos sem autenticação prévia.
        scope.setUser(request.user ? {
          id: request.user.sub,
          papel: request.user.papel,
          email: request.user.email,
          nome: request.user.nome,
        } : undefined)
        Sentry.captureException(error)
      })
    }

    if (status >= 500) {
      return reply.code(500).send({ error: 'Erro interno do servidor' })
    }
    return reply.code(status).send({ error: error.message })
  })

  return app
}
