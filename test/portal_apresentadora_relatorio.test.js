import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { portalApresentadoraRoutes } from '../src/routes/portal_apresentadora.js'
import { ROTAS_API_KEY, ROTAS_API_KEY_FINANCEIRO } from '../src/plugins/auth.js'
import { rejectOtherPresenterReport } from '../src/services/portal-apresentadora-relatorio.js'
import { remuneracaoApresentadorasRoutes } from '../src/routes/remuneracao_apresentadoras.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const ownId = '33333333-3333-4333-8333-333333333333'
const otherId = '44444444-4444-4444-8444-444444444444'

function portalClient() {
  return {
    query: async (sql) => {
      const text = String(sql)
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text.startsWith('SET LOCAL') || text.startsWith('SELECT set_config')) return { rows: [] }
      if (text.includes('a.user_id')) return { rows: [{ id: ownId, nome: 'Ana', foto_url: null, fixo: '2700' }] }
      return { rows: [] }
    },
    release() {},
  }
}

async function buildPortal() {
  const app = Fastify()
  const finance = vi.fn().mockResolvedValue({ rows: [] })
  app.decorate('authenticate', async (request) => { request.user = { tenant_id: tenant, sub: userId, papel: 'apresentadora' } })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'forbidden' })
  })
  app.decorate('db', { pool: { connect: async () => portalClient() } })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query: finance }))
  const previous = process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST
  process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST = tenant
  await app.register(portalApresentadoraRoutes)
  return { app, finance, restore: () => { process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST = previous } }
}

describe('relatório mensal da própria apresentadora', () => {
  it('recusa o id de outra apresentadora antes de montar o relatório', () => {
    expect(() => rejectOtherPresenterReport(ownId, otherId)).toThrow(/próprio relatório/)
    expect(() => rejectOtherPresenterReport(ownId, '')).not.toThrow()
    expect(() => rejectOtherPresenterReport(ownId, ownId)).not.toThrow()
  })

  it('devolve o fechamento dela e rejeita outro apresentadora_id', async () => {
    const { app, finance, restore } = await buildPortal()
    try {
      const own = await app.inject({ method: 'GET', url: '/v1/portal/apresentadora/relatorio-mensal?mes=2026-09' })
      expect(own.statusCode).toBe(200)
      expect(own.json()).toMatchObject({
        mes: '2026-09',
        fechamento: { apresentadora_id: ownId, nome: 'Ana' },
        detalhes: { apresentadora_id: ownId, mes: '2026-09', memoria_completa: true },
      })
      expect(finance).toHaveBeenCalled()

      const foreign = await app.inject({ method: 'GET', url: `/v1/portal/apresentadora/relatorio-mensal?mes=2026-09&apresentadora_id=${otherId}` })
      expect(foreign.statusCode).toBe(403)
      expect(foreign.json().error).toMatch(/próprio/)
    } finally {
      await app.close()
      restore()
    }
  })

  it('não entra na allowlist de chave de API', () => {
    const paths = [...ROTAS_API_KEY, ...ROTAS_API_KEY_FINANCEIRO].map((entry) => entry[1])
    expect(paths.join('\n')).not.toContain('relatorio-mensal')
    expect(paths.join('\n')).not.toContain('/v1/portal/apresentadora')
  })

  it('o gestor continua abrindo o relatório existente', async () => {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => {
      request.user = { tenant_id: tenant, sub: userId, papel: 'gerente' }
    })
    app.decorate('withTenant', async (_tenant, fn) => fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }))
    await app.register(remuneracaoApresentadorasRoutes)
    const res = await app.inject({ method: 'GET', url: `/v1/financeiro/fechamento-apresentadoras/${ownId}/detalhes?mes=2026-09` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ apresentadora_id: ownId, mes: '2026-09', memoria_completa: true })
    await app.close()
  })
})
