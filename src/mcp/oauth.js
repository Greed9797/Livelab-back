import { Provider, errors } from 'oidc-provider'
import { READ_ANALYTICS, READ_FINANCEIRO } from '../config/role_groups.js'
import { artifactHash, createOAuthAdapter } from './oauth-adapter.js'

export const SCOPES = { analytics: 'livelab:analytics:read', finance: 'livelab:finance:read' }
export function authorizeMcpUser(user, scope, domain, tokenVersion) {
  return Boolean(user?.ativo && user.tenant_id && user.papel !== 'automacao'
    && Number(user.token_version ?? 1) === Number(tokenVersion)
    && String(scope || '').split(' ').includes(SCOPES[domain])
    && (domain === 'finance' ? READ_FINANCEIRO : READ_ANALYTICS).includes(user.papel))
}

export function readMcpConfig(env = process.env) {
  if (env.MCP_ENABLED !== 'true') return { enabled: false }
  const publicUrl = new URL(env.MCP_PUBLIC_URL)
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('MCP_PUBLIC_URL deve ser uma origem HTTPS sem caminho')
  }
  const redirect = new URL(env.MCP_CHATGPT_REDIRECT_URI)
  if (redirect.protocol !== 'https:' || redirect.hostname !== 'chatgpt.com' || redirect.username || redirect.password || redirect.hash) {
    throw new Error('MCP_CHATGPT_REDIRECT_URI deve ser o callback HTTPS exato do ChatGPT')
  }
  const cookieKeys = JSON.parse(env.MCP_COOKIE_KEYS || '[]')
  const jwks = JSON.parse(env.MCP_JWKS || '{}')
  if (!env.MCP_CHATGPT_CLIENT_ID || !Array.isArray(cookieKeys) || !cookieKeys.length
    || cookieKeys.some(key => typeof key !== 'string' || key.length < 32)
    || Buffer.from(env.MCP_STORAGE_KEY || '', 'base64').length !== 32
    || !Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.some(key => !key.d || !key.kid)) {
    throw new Error('Configuração MCP OAuth incompleta')
  }
  return { enabled: true, origin: publicUrl.origin, issuer: `${publicUrl.origin}/oauth`,
    resource: `${publicUrl.origin}/mcp`, clientId: env.MCP_CHATGPT_CLIENT_ID,
    redirectUri: redirect.href, cookieKeys, jwks, storageKey: env.MCP_STORAGE_KEY }
}

export async function loadMcpUser(db, id) {
  const { rows } = await db.query('SELECT id, tenant_id, papel, ativo, token_version FROM users WHERE id = $1::uuid', [id])
  return rows[0]
}

export function createMcpProvider(app, config) {
  let provider
  provider = new Provider(config.issuer, {
    adapter: createOAuthAdapter(app.db, config.storageKey), jwks: config.jwks,
    clients: [{ client_id: config.clientId, redirect_uris: [config.redirectUri],
      response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none', scope: `openid offline_access ${Object.values(SCOPES).join(' ')}` }],
    cookies: { keys: config.cookieKeys },
    pkce: { required: () => true, methods: ['S256'] },
    scopes: ['openid', 'offline_access', ...Object.values(SCOPES)],
    features: { devInteractions: { enabled: false }, revocation: { enabled: true },
      resourceIndicators: { enabled: true, defaultResource: () => config.resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== config.resource) throw new errors.InvalidTarget()
          return { scope: Object.values(SCOPES).join(' '), audience: config.resource, accessTokenFormat: 'opaque' }
        } } },
    interactions: { url: (_ctx, interaction) => `/mcp/login/${interaction.uid}` },
    ttl: { AccessToken: 900, AuthorizationCode: 60, RefreshToken: 604800, Grant: 604800, Session: 3600, Interaction: 600 },
    rotateRefreshToken: true,
    // O formulário próprio exige consentimento explícito para acesso persistente.
    issueRefreshToken: (_ctx, client) => client.clientId === config.clientId && client.grantTypeAllowed('refresh_token'),
    expiresWithSession: () => false,
    findAccount: async (_ctx, id) => {
      const user = await loadMcpUser(app.db, id)
      if (!user?.ativo || !user.tenant_id) return undefined
      return { accountId: user.id, claims: async () => ({ sub: user.id }) }
    },
    extraTokenClaims: async (_ctx, token) => {
      const user = await loadMcpUser(app.db, token.accountId)
      const { rows } = await app.db.query('SELECT tenant_id, token_version FROM mcp_oauth_bindings WHERE grant_hash = $1', [artifactHash(token.grantId)])
      const binding = rows[0]
      const allowed = Object.keys(SCOPES).some(domain => authorizeMcpUser(user, token.scope, domain, binding?.token_version))
      if (!binding || binding.tenant_id !== user?.tenant_id || !allowed) throw new errors.InvalidGrant('Autorização revogada; conecte novamente')
      return { tenant_id: binding.tenant_id, token_version: binding.token_version }
    },
  })
  provider.proxy = true
  return provider
}

export async function authenticateMcpBearer(app, provider, config, header) {
  if (typeof header !== 'string' || !/^Bearer [^\s]+$/i.test(header)) return null
  const token = await provider.AccessToken.find(header.slice(7))
  if (!token || token.isExpired || token.aud !== config.resource || token.clientId !== config.clientId || !token.grantId) return null
  if (!await provider.Grant.find(token.grantId)) return null
  const user = await loadMcpUser(app.db, token.accountId)
  if (!user?.ativo || user.tenant_id !== token.extra?.tenant_id
    || Number(user.token_version ?? 1) !== Number(token.extra?.token_version)) return null
  return { user, scope: token.scope, tokenVersion: token.extra.token_version }
}
