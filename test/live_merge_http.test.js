import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  preview: vi.fn(),
  merge: vi.fn(),
  history: vi.fn(),
  undo: vi.fn(),
  invalidateTenant: vi.fn(),
  invalidateHome: vi.fn(),
}))

vi.mock('../src/lib/live-merge.js', () => ({
  isLiveMergeEnabled: mocks.enabled,
}))

vi.mock('../src/services/live-merge.js', () => ({
  previewLiveMerge: mocks.preview,
  mergeLives: mocks.merge,
  getLiveMergeHistory: mocks.history,
  undoLiveMerge: mocks.undo,
  LiveMergeError: class LiveMergeError extends Error {
    constructor(message, { code, statusCode = 400, blockers } = {}) {
      super(message)
      this.code = code
      this.statusCode = statusCode
      this.blockers = blockers
    }
  },
}))

vi.mock('../src/lib/dashboard-cache.js', () => ({
  invalidateTenant: mocks.invalidateTenant,
}))

vi.mock('../src/routes/home.js', () => ({
  invalidateHomeDashboard: mocks.invalidateHome,
}))

const { liveMergeRoutes } = await import('../src/routes/live-merge.js')
const { LiveMergeError } = await import('../src/services/live-merge.js')

const tenantId = '11111111-1111-4111-8111-111111111111'
const userId = '55555555-5555-4555-8555-555555555555'
const liveA = '77777777-7777-4777-8777-777777777777'
const liveB = '88888888-8888-4888-8888-888888888888'
const unionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const destinationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const requestId = '99999999-9999-4999-8999-999999999999'
const previewToken = `lm1:${'a'.repeat(64)}`

function mergePayload(overrides = {}) {
  return {
    live_ids: [liveA, liveB],
    preview_token: previewToken,
    request_id: requestId,
    motivo: 'Troca de apresentadora',
    metricas_por_trecho: true,
    ...overrides,
  }
}

async function buildApp({ papel = 'gerente', audit = true } = {}) {
  const app = Fastify()
  const db = { query: vi.fn() }
  const auditLog = vi.fn().mockResolvedValue(undefined)

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: userId, papel }
  })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
  })
  app.decorate('withTenant', async (receivedTenantId, operation) => {
    expect(receivedTenantId).toBe(tenantId)
    return operation(db)
  })
  if (audit) app.decorate('audit', { log: auditLog })
  await app.register(liveMergeRoutes)
  return { app, auditLog, db }
}

describe('HTTP live merge routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.enabled.mockReturnValue(true)
  })

  it.each(['franqueador_master', 'franqueado', 'gerente', 'operacional'])(
    'allows manager role %s to read capabilities',
    async (papel) => {
      const { app } = await buildApp({ papel })

      const response = await app.inject({ method: 'GET', url: '/v1/lives/uniao/capabilities' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ enabled: true })
      expect(mocks.enabled).toHaveBeenCalledWith(tenantId)
      await app.close()
    },
  )

  it('returns the service preview for the authenticated tenant', async () => {
    const preview = {
      eligible: true,
      blockers: [],
      preview_token: previewToken,
      origens: [{ live_id: liveA }, { live_id: liveB }],
      totais: { gmv: 300, pedidos: 5, segundos: 7200 },
      apresentadoras: [],
      warnings: [],
    }
    mocks.preview.mockResolvedValue(preview)
    const { app, db } = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lives/uniao/preview',
      payload: { live_ids: [liveA, liveB] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(preview)
    expect(mocks.preview).toHaveBeenCalledWith(db, { tenantId, liveIds: [liveA, liveB] })
    await app.close()
  })

  it('creates a union, returns committed ids with 201, audits and invalidates caches', async () => {
    const committed = { live_id: destinationId, uniao_id: unionId }
    mocks.merge.mockResolvedValue(committed)
    const { app, auditLog, db } = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lives/uniao',
      payload: mergePayload(),
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual(committed)
    expect(mocks.merge).toHaveBeenCalledWith(db, {
      tenantId,
      userId,
      liveIds: [liveA, liveB],
      previewToken,
      requestId,
      motivo: 'Troca de apresentadora',
      metricasPorTrecho: true,
    })
    expect(auditLog).toHaveBeenCalledWith(expect.anything(), {
      action: 'live.unir',
      entity_type: 'live_uniao',
      entity_id: unionId,
      metadata: { live_destino_id: destinationId, origens: [liveA, liveB] },
    })
    expect(mocks.invalidateTenant).toHaveBeenCalledWith(tenantId)
    expect(mocks.invalidateHome).toHaveBeenCalledWith(tenantId)
    await app.close()
  })

  it('returns union history and null without requiring the create feature flag', async () => {
    const history = { id: unionId, live_destino_id: destinationId, ativo: true, origens: [] }
    mocks.history.mockResolvedValueOnce(history).mockResolvedValueOnce(null)
    mocks.enabled.mockReturnValue(false)
    const { app, db } = await buildApp()

    const found = await app.inject({ method: 'GET', url: `/v1/lives/${destinationId}/uniao` })
    const absent = await app.inject({ method: 'GET', url: `/v1/lives/${liveA}/uniao` })

    expect(found.statusCode).toBe(200)
    expect(found.json()).toEqual(history)
    expect(absent.statusCode).toBe(200)
    expect(absent.json()).toBeNull()
    expect(mocks.history).toHaveBeenNthCalledWith(1, db, { tenantId, liveId: destinationId })
    expect(mocks.enabled).not.toHaveBeenCalled()
    await app.close()
  })

  it('undoes a union while the create feature is disabled and invalidates caches', async () => {
    const restored = { live_ids: [liveA, liveB] }
    mocks.undo.mockResolvedValue(restored)
    mocks.enabled.mockReturnValue(false)
    const { app, auditLog, db } = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/v1/lives/uniao/${unionId}/desfazer`,
      payload: { request_id: requestId, motivo: 'União feita por engano' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(restored)
    expect(mocks.undo).toHaveBeenCalledWith(db, {
      tenantId,
      userId,
      unionId,
      requestId,
      motivo: 'União feita por engano',
    })
    expect(auditLog).toHaveBeenCalledWith(expect.anything(), {
      action: 'live.uniao_desfazer',
      entity_type: 'live_uniao',
      entity_id: unionId,
      metadata: { live_ids: [liveA, liveB] },
    })
    expect(mocks.invalidateTenant).toHaveBeenCalledWith(tenantId)
    expect(mocks.invalidateHome).toHaveBeenCalledWith(tenantId)
    expect(mocks.enabled).not.toHaveBeenCalled()
    await app.close()
  })

  it.each(['apresentador', 'automacao', 'cliente_parceiro'])(
    'rejects unauthorized role %s before reaching any merge service',
    async (papel) => {
      const { app } = await buildApp({ papel })
      const requests = [
        { method: 'GET', url: '/v1/lives/uniao/capabilities' },
        { method: 'POST', url: '/v1/lives/uniao/preview', payload: { live_ids: [liveA, liveB] } },
        { method: 'POST', url: '/v1/lives/uniao', payload: mergePayload() },
        { method: 'GET', url: `/v1/lives/${liveA}/uniao` },
        {
          method: 'POST',
          url: `/v1/lives/uniao/${unionId}/desfazer`,
          payload: { request_id: requestId, motivo: 'Reverter união' },
        },
      ]

      for (const request of requests) {
        const response = await app.inject(request)
        expect(response.statusCode).toBe(403)
      }
      expect(mocks.preview).not.toHaveBeenCalled()
      expect(mocks.merge).not.toHaveBeenCalled()
      expect(mocks.history).not.toHaveBeenCalled()
      expect(mocks.undo).not.toHaveBeenCalled()
      await app.close()
    },
  )

  it.each([
    ['requires two live ids', { live_ids: [liveA] }],
    ['rejects malformed live ids', { live_ids: [liveA, 'not-a-uuid'] }],
    ['rejects unknown fields', { live_ids: [liveA, liveB], extra: true }],
  ])('preview validation: %s', async (_name, payload) => {
    const { app } = await buildApp()

    const response = await app.inject({ method: 'POST', url: '/v1/lives/uniao/preview', payload })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mocks.preview).not.toHaveBeenCalled()
    await app.close()
  })

  it.each([
    ['missing reason', { motivo: undefined }, 'VALIDATION_ERROR'],
    ['short reason', { motivo: 'x' }, 'VALIDATION_ERROR'],
    ['invalid request id', { request_id: 'bad-id' }, 'VALIDATION_ERROR'],
    ['invalid preview token', { preview_token: 'lm1:abc' }, 'VALIDATION_ERROR'],
    ['missing metrics confirmation', { metricas_por_trecho: undefined }, 'METRICS_SCOPE_CONFIRMATION_REQUIRED'],
    ['negative metrics confirmation', { metricas_por_trecho: false }, 'METRICS_SCOPE_CONFIRMATION_REQUIRED'],
  ])('create validation: %s', async (_name, overrides, code) => {
    const payload = mergePayload(overrides)
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key]
    }
    const { app } = await buildApp()

    const response = await app.inject({ method: 'POST', url: '/v1/lives/uniao', payload })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code })
    expect(mocks.merge).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects invalid history and undo params and an undo body without reason', async () => {
    const { app } = await buildApp()

    const badHistory = await app.inject({ method: 'GET', url: '/v1/lives/not-a-uuid/uniao' })
    const badUnion = await app.inject({
      method: 'POST',
      url: '/v1/lives/uniao/not-a-uuid/desfazer',
      payload: { request_id: requestId, motivo: 'Reverter união' },
    })
    const missingReason = await app.inject({
      method: 'POST',
      url: `/v1/lives/uniao/${unionId}/desfazer`,
      payload: { request_id: requestId },
    })

    for (const response of [badHistory, badUnion, missingReason]) {
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
    expect(mocks.history).not.toHaveBeenCalled()
    expect(mocks.undo).not.toHaveBeenCalled()
    await app.close()
  })

  it('blocks preview and create when disabled, but not history or undo', async () => {
    mocks.enabled.mockReturnValue(false)
    mocks.history.mockResolvedValue(null)
    mocks.undo.mockResolvedValue({ live_ids: [liveA, liveB] })
    const { app } = await buildApp()

    const preview = await app.inject({
      method: 'POST',
      url: '/v1/lives/uniao/preview',
      payload: { live_ids: [liveA, liveB] },
    })
    const create = await app.inject({ method: 'POST', url: '/v1/lives/uniao', payload: mergePayload() })
    const history = await app.inject({ method: 'GET', url: `/v1/lives/${liveA}/uniao` })
    const undo = await app.inject({
      method: 'POST',
      url: `/v1/lives/uniao/${unionId}/desfazer`,
      payload: { request_id: requestId, motivo: 'Reverter união' },
    })

    expect(preview.statusCode).toBe(404)
    expect(create.statusCode).toBe(404)
    expect(preview.json()).toMatchObject({ code: 'LIVE_MERGE_DISABLED' })
    expect(create.json()).toMatchObject({ code: 'LIVE_MERGE_DISABLED' })
    expect(history.statusCode).toBe(200)
    expect(undo.statusCode).toBe(200)
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.history).toHaveBeenCalledOnce()
    expect(mocks.undo).toHaveBeenCalledOnce()
    await app.close()
  })

  it.each([
    ['preview', 'LIVE_MERGE_INELIGIBLE', [{ code: 'LIVES_NOT_CONTIGUOUS', message: 'Lives não contíguas.' }]],
    ['create', 'PREVIEW_STALE', undefined],
    ['undo', 'UNION_STATE_CHANGED', undefined],
  ])('maps %s domain conflicts to HTTP 409', async (operation, code, blockers) => {
    const error = new LiveMergeError('Conflito na união.', { code, statusCode: 409, blockers })
    const serviceMock = operation === 'create' ? mocks.merge : mocks[operation]
    serviceMock.mockRejectedValue(error)
    const { app } = await buildApp()
    const requests = {
      preview: { method: 'POST', url: '/v1/lives/uniao/preview', payload: { live_ids: [liveA, liveB] } },
      create: { method: 'POST', url: '/v1/lives/uniao', payload: mergePayload() },
      undo: {
        method: 'POST',
        url: `/v1/lives/uniao/${unionId}/desfazer`,
        payload: { request_id: requestId, motivo: 'Reverter união' },
      },
    }

    const response = await app.inject(requests[operation])

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'Conflito na união.', code, ...(blockers ? { blockers } : {}) })
    await app.close()
  })
})
