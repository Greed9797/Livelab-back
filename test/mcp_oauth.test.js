import { describe, it, expect, vi } from 'vitest'
import { authorizeMcpUser, readMcpConfig } from '../src/mcp/oauth.js'
import { createOAuthAdapter } from '../src/mcp/oauth-adapter.js'

const user = { id: 'u', tenant_id: 't', ativo: true, papel: 'franqueado', token_version: 3 }
describe('MCP OAuth policy', () => {
  it('aplica interseção de escopo e papel atuais', () => {
    expect(authorizeMcpUser(user, 'livelab:analytics:read', 'analytics', 3)).toBe(true)
    expect(authorizeMcpUser(user, 'livelab:analytics:read', 'finance', 3)).toBe(false)
    expect(authorizeMcpUser({ ...user, papel: 'marketing' }, 'livelab:finance:read', 'finance', 3)).toBe(false)
    expect(authorizeMcpUser({ ...user, papel: 'financeiro_readonly' }, 'livelab:finance:read', 'finance', 3)).toBe(true)
  })
  it('nega bloqueio, mudança de senha, tenant ausente e identidade de automação', () => {
    for (const current of [{ ...user, ativo: false }, { ...user, token_version: 4 }, { ...user, tenant_id: null }, { ...user, papel: 'automacao' }]) {
      expect(authorizeMcpUser(current, 'livelab:analytics:read livelab:finance:read', 'analytics', 3)).toBe(false)
    }
  })
  it('fica desligado por padrão e falha fechado com configuração incompleta ou insegura', () => {
    expect(readMcpConfig({}).enabled).toBe(false)
    expect(() => readMcpConfig({ MCP_ENABLED: 'true' })).toThrow()
    expect(() => readMcpConfig({ MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'http://example.com' })).toThrow()
  })
  it('adapter consulta por hash e nunca persiste bearer bruto como chave', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const Adapter = createOAuthAdapter(db, Buffer.alloc(32, 1).toString('base64'))
    await new Adapter('AccessToken').upsert('bearer-secreto', { accountId: 'u' }, 60)
    const params = db.query.mock.calls[0][1]
    expect(params[1]).toMatch(/^[a-f0-9]{64}$/)
    expect(params).not.toContain('bearer-secreto')
    expect(params[2]).not.toContain('accountId')
  })
  it('consumo atômico impede replay concorrente de códigos/tokens', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
    const Adapter = createOAuthAdapter(db, Buffer.alloc(32, 1).toString('base64'))
    await expect(new Adapter('AuthorizationCode').consume('usado')).rejects.toThrow('invalid_grant')
    expect(db.query.mock.calls[0][0]).toContain('consumed_at IS NULL')
  })
})
