import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const previewMock = vi.fn()
const mergeMock = vi.fn()
const historyMock = vi.fn()
const undoMock = vi.fn()

vi.mock('../src/services/live-merge.js', () => ({
  previewLiveMerge: previewMock,
  mergeLives: mergeMock,
  getLiveMergeHistory: historyMock,
  undoLiveMerge: undoMock,
  LiveMergeError: class LiveMergeError extends Error {},
}))

const { liveMergeRoutes } = await import('../src/routes/live-merge.js')

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveA = '77777777-7777-4777-8777-777777777777'
const liveB = '88888888-8888-4888-8888-888888888888'
const requestId = '99999999-9999-4999-8999-999999999999'

function buildApp() {
  const app = Fastify()
  let allowedRoles
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: '55555555-5555-4555-8555-555555555555', papel: 'gerente' }
  })
  app.decorate('requirePapel', (roles) => {
    allowedRoles = roles
    return async () => {}
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query: vi.fn() }))
  app.decorate('audit', { log: vi.fn(async () => {}) })
  return { app, getAllowedRoles: () => allowedRoles }
}

describe('live merge routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LIVE_MERGE_TENANT_ALLOWLIST = tenantId
  })

  it('expõe capability desabilitada sem allowlist', async () => {
    delete process.env.LIVE_MERGE_TENANT_ALLOWLIST
    const { app, getAllowedRoles } = buildApp()
    await app.register(liveMergeRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/lives/uniao/capabilities' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: false })
    expect(getAllowedRoles()).toEqual(['franqueador_master', 'franqueado', 'gerente', 'operacional'])
    await app.close()
  })

  it('valida o corpo e devolve a prévia do serviço', async () => {
    previewMock.mockResolvedValue({ eligible: true, preview_token: 'lm1:abc' })
    const { app } = buildApp()
    await app.register(liveMergeRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/lives/uniao/preview', payload: { live_ids: [liveA, liveB] } })
    expect(res.statusCode).toBe(200)
    expect(previewMock).toHaveBeenCalledWith(expect.anything(), { tenantId, liveIds: [liveA, liveB] })
    await app.close()
  })

  it('exige confirmação de que as métricas pertencem aos trechos', async () => {
    const { app } = buildApp()
    await app.register(liveMergeRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/uniao',
      payload: { live_ids: [liveA, liveB], preview_token: 'lm1:abc', request_id: requestId, motivo: 'Troca de apresentadora' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'METRICS_SCOPE_CONFIRMATION_REQUIRED' })
    expect(mergeMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('exige motivo explícito para a trilha de auditoria', async () => {
    const { app } = buildApp()
    await app.register(liveMergeRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/uniao',
      payload: {
        live_ids: [liveA, liveB],
        preview_token: `lm1:${'a'.repeat(64)}`,
        request_id: requestId,
        metricas_por_trecho: true,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(mergeMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('retorna null quando a live não pertence a uma união', async () => {
    historyMock.mockResolvedValue(null)
    const { app } = buildApp()
    await app.register(liveMergeRoutes)
    const res = await app.inject({ method: 'GET', url: `/v1/lives/${liveA}/uniao` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
    await app.close()
  })
})
