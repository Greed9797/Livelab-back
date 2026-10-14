import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { loginSchema } from '../schemas/auth.schema.js'
import { authenticateAccount } from '../services/account-credentials.js'
import { artifactHash } from './oauth-adapter.js'
import { readMcpConfig, createMcpProvider, authenticateMcpBearer, authorizeMcpUser, SCOPES } from './oauth.js'
import { toolDefinitions, executeTool, canUseTool } from './tools.js'

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
function csrf(config, interaction, timestamp) {
  const value = `${timestamp}.${interaction.uid}.${interaction.prompt.name}`
  return `${timestamp}.${createHmac('sha256', config.cookieKeys[0]).update(value).digest('hex')}`
}
function validCsrf(config, details, input) {
  if (typeof input !== 'string') return false
  const timestamp = Number(input.split('.')[0])
  if (!Number.isFinite(timestamp) || timestamp > Date.now() || Date.now() - timestamp > 600000) return false
  const expected = Buffer.from(csrf(config, details, timestamp)), provided = Buffer.from(input)
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}
function loginPage(details, config) {
  const scope = String(details.params.scope || '').split(' ')
  const permissions = Object.entries(SCOPES).filter(([, value]) => scope.includes(value)).map(([domain]) => domain === 'finance'
    ? '<li>Consultar financeiro: receitas calculadas, custos, comissões e fechamento dos apresentadores.</li>'
    : '<li>Consultar desempenho: GMV, horas, apresentadores, marcas, cabines e metas.</li>').join('')
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Conectar Livelab</title><body>
    <main><h1>Conectar Livelab ao ChatGPT</h1><p>Autorize as consultas abaixo com sua conta Livelab. Suas permissões atuais continuam valendo.</p>
    <ul>${permissions}</ul><p>A conexão permite consultas e poderá renovar o acesso até você desconectar ou revogar a autorização. Nenhum pagamento ou alteração será realizado.</p>
    <form method="post" action="/mcp/login/${escape(details.uid)}">
    <input type="hidden" name="csrf" value="${csrf(config, details, Date.now())}">
    <p><label>E-mail <input name="email" type="email" autocomplete="username" maxlength="254" required></label></p>
    <p><label>Senha <input name="senha" type="password" autocomplete="current-password" maxlength="200" required></label></p>
    <button name="acao" value="autorizar" type="submit">Entrar e autorizar consultas</button>
    <button name="acao" value="cancelar" type="submit" formnovalidate>Cancelar</button>
    </form></main></body></html>`
}

export async function mcpRoutes(app, options = {}) {
  const config = options.config || readMcpConfig()
  if (!config.enabled) return
  const provider = createMcpProvider(app, config)
  if (options.onProvider) options.onProvider(provider)
  const callback = provider.callback()
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_request, body, done) => {
    const entries = [...new URLSearchParams(body)]
    if (new Set(entries.map(([key]) => key)).size !== entries.length) return done(Object.assign(new Error('Campos duplicados'), { statusCode: 400 }))
    done(null, Object.fromEntries(entries))
  })

  // oidc-provider consome o stream original antes do parser Fastify, sob os limites do provider.
  const oidcHandler = async (request, reply) => {
    reply.hijack()
    request.raw.originalUrl = request.raw.url
    request.raw.url = request.raw.url.replace(/^\/oauth(?=\/|\?|$)/, '') || '/'
    return callback(request.raw, reply.raw)
  }
  app.route({ method: ['GET', 'POST'], url: '/oauth/*', logLevel: 'silent', onRequest: oidcHandler, handler: async () => {} })
  app.get('/.well-known/oauth-authorization-server/oauth', async (_request, reply) => {
    return reply.redirect(`${config.issuer}/.well-known/openid-configuration`)
  })
  const metadata = async (_request, reply) => reply.header('cache-control', 'no-store').send({
    resource: config.resource, authorization_servers: [config.issuer], scopes_supported: Object.values(SCOPES),
    bearer_methods_supported: ['header'], resource_name: 'Livelab — desempenho e financeiro',
  })
  app.get('/.well-known/oauth-protected-resource/mcp', metadata)
  app.get('/.well-known/oauth-protected-resource', metadata)

  app.get('/mcp/login/:uid', { logLevel: 'silent', config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const details = await provider.interactionDetails(request.raw, reply.raw)
    if (details.uid !== request.params.uid || !['login', 'consent'].includes(details.prompt.name)) return reply.code(400).send({ error: 'Interação inválida' })
    return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .header('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
      .type('text/html').send(loginPage(details, config))
  })
  app.post('/mcp/login/:uid', { logLevel: 'silent', config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, bodyLimit: 8192 }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const details = await provider.interactionDetails(request.raw, reply.raw)
    if (details.uid !== request.params.uid || request.headers.origin !== config.origin || !validCsrf(config, details, request.body?.csrf)) {
      return reply.code(403).send({ error: 'Formulário inválido ou expirado' })
    }
    if (request.body?.acao === 'cancelar') {
      reply.hijack()
      return provider.interactionFinished(request.raw, reply.raw, { error: 'access_denied' }, { mergeWithLastSubmission: false })
    }
    const credentials = loginSchema.safeParse({ email: request.body?.email, senha: request.body?.senha })
    if (request.body?.acao !== 'autorizar' || !credentials.success) return reply.code(400).send({ error: 'Informe e-mail e senha válidos' })
    const user = await authenticateAccount(app.db, credentials.data.email, credentials.data.senha)
    if (!user || (details.prompt.name === 'consent' && details.session?.accountId !== user.id)) return reply.code(401).send({ error: 'Credenciais inválidas' })
    const requested = String(details.params.scope || '').split(' ')
    const resourceScopes = Object.values(SCOPES).filter(scope => requested.includes(scope))
    if (!resourceScopes.length || resourceScopes.some(scope => !authorizeMcpUser(user, scope,
      scope === SCOPES.finance ? 'finance' : 'analytics', user.token_version ?? 1))) return reply.code(403).send({ error: 'Sua conta não permite os acessos solicitados' })
    const grant = new provider.Grant({ accountId: user.id, clientId: config.clientId })
    grant.addOIDCScope(requested.join(' '))
    grant.addResourceScope(config.resource, resourceScopes.join(' '))
    const grantId = await grant.save()
    await app.db.query(`INSERT INTO mcp_oauth_bindings (grant_hash, user_id, tenant_id, token_version)
      VALUES ($1, $2::uuid, $3::uuid, $4)`, [artifactHash(grantId), user.id, user.tenant_id, user.token_version ?? 1])
    await app.audit?.log?.({ ...request, user: { sub: user.id, tenant_id: user.tenant_id, papel: user.papel } }, {
      action: 'mcp.oauth.consent', entity_type: 'user', entity_id: user.id, metadata: { scopes: resourceScopes },
    })
    reply.hijack()
    return provider.interactionFinished(request.raw, reply.raw,
      { login: { accountId: user.id, remember: false }, consent: { grantId } }, { mergeWithLastSubmission: false })
  })

  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', bodyLimit: 65536,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const identity = await authenticateMcpBearer(app, provider, config, request.headers.authorization)
      if (!identity) return reply.header('www-authenticate', `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp"`)
        .code(401).send({ error: 'Conecte sua conta Livelab para consultar' })
      if (request.method !== 'POST') return reply.header('allow', 'POST').code(405).send({ error: 'Transporte sem sessão; use POST' })
      const server = new McpServer({ name: 'livelab', version: '1.0.0' })
      for (const def of toolDefinitions.filter(t => canUseTool(identity, t))) {
        server.registerTool(def.name, { description: def.description, inputSchema: def.schema,
          outputSchema: z.object({ periodo: z.record(z.string(), z.unknown()), filtros: z.record(z.string(), z.unknown()),
            consultado_em: z.string(), timezone: z.string(), moeda: z.string(), origem: z.string(), avisos: z.array(z.string()), dados: z.unknown() }),
          annotations: def.annotations }, async args => {
          try {
            const result = await executeTool(app, identity, def.name, args)
            const text = JSON.stringify(result)
            if (Buffer.byteLength(text) > 2_000_000) throw Object.assign(new Error('Resposta muito grande; reduza o período ou use filtros'), { statusCode: 422 })
            await app.audit?.log?.({ ...request, user: { sub: identity.user.id, tenant_id: identity.user.tenant_id, papel: identity.user.papel } }, {
              action: 'mcp.tool.read', entity_type: 'mcp', entity_id: null, metadata: { tool: def.name },
            })
            return { content: [{ type: 'text', text }], structuredContent: result }
          } catch (error) {
            app.log.warn({ tool: def.name, code: error.statusCode || 'query_failed' }, 'Consulta MCP falhou')
            return { isError: true, content: [{ type: 'text', text: error.statusCode ? error.message : 'Falha ao consultar dados; tente novamente ou reduza o período' }] }
          }
        })
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
        enableDnsRebindingProtection: true, allowedHosts: [new URL(config.origin).host], allowedOrigins: [config.origin, 'https://chatgpt.com'] })
      await server.connect(transport)
      reply.raw.on('close', () => { void server.close().catch(() => {}) })
      reply.hijack()
      await transport.handleRequest(request.raw, reply.raw, request.body)
    },
  })
}
