import { z } from 'zod'

import { invalidateTenant } from '../lib/dashboard-cache.js'
import { isLiveMergeEnabled } from '../lib/live-merge.js'
import {
  getLiveMergeHistory,
  LiveMergeError,
  mergeLives,
  previewLiveMerge,
  undoLiveMerge,
} from '../services/live-merge.js'
import { invalidateHomeDashboard } from './home.js'

const MANAGER_ROLES = ['franqueador_master', 'franqueado', 'gerente', 'operacional']
const uuid = z.string().uuid()
const liveIds = z.array(uuid).min(2).max(20)
const previewSchema = z.object({ live_ids: liveIds }).strict()
const mergeSchema = z.object({
  live_ids: liveIds,
  preview_token: z.string().regex(/^lm1:[a-f0-9]{64}$/),
  request_id: uuid,
  motivo: z.string().trim().min(3).max(500),
  metricas_por_trecho: z.literal(true),
}).strict()
const undoSchema = z.object({
  request_id: uuid,
  motivo: z.string().trim().min(3).max(500),
}).strict()
const idParams = z.object({ id: uuid })

function validationError(reply, parsed) {
  return reply.code(400).send({
    error: parsed.error.issues[0]?.message ?? 'Dados inválidos',
    code: 'VALIDATION_ERROR',
  })
}

function disabled(reply) {
  return reply.code(404).send({
    error: 'União de lives não está habilitada para esta unidade.',
    code: 'LIVE_MERGE_DISABLED',
  })
}

function handleMergeError(error, reply) {
  if (!(error instanceof LiveMergeError)) throw error
  const payload = { error: error.message, code: error.code }
  if (error.blockers) payload.blockers = error.blockers
  return reply.code(error.statusCode).send(payload)
}

export async function liveMergeRoutes(app) {
  const managerAccess = [app.authenticate, app.requirePapel(MANAGER_ROLES)]

  app.get('/v1/lives/uniao/capabilities', { preHandler: managerAccess }, async (request) => ({
    enabled: isLiveMergeEnabled(request.user.tenant_id),
  }))

  app.post('/v1/lives/uniao/preview', { preHandler: managerAccess }, async (request, reply) => {
    if (!isLiveMergeEnabled(request.user.tenant_id)) return disabled(reply)
    const parsed = previewSchema.safeParse(request.body)
    if (!parsed.success) return validationError(reply, parsed)
    try {
      return await app.withTenant(request.user.tenant_id, (db) => previewLiveMerge(db, {
        tenantId: request.user.tenant_id,
        liveIds: parsed.data.live_ids,
      }))
    } catch (error) {
      return handleMergeError(error, reply)
    }
  })

  app.post('/v1/lives/uniao', { preHandler: managerAccess }, async (request, reply) => {
    if (!isLiveMergeEnabled(request.user.tenant_id)) return disabled(reply)
    const parsed = mergeSchema.safeParse(request.body)
    if (!parsed.success) {
      const metricsIssue = parsed.error.issues.some((issue) => issue.path[0] === 'metricas_por_trecho')
      if (metricsIssue) {
        return reply.code(400).send({
          error: 'Confirme que as métricas pertencem a cada trecho.',
          code: 'METRICS_SCOPE_CONFIRMATION_REQUIRED',
        })
      }
      return validationError(reply, parsed)
    }
    try {
      const result = await app.withTenant(request.user.tenant_id, (db) => mergeLives(db, {
        tenantId: request.user.tenant_id,
        userId: request.user.sub,
        liveIds: parsed.data.live_ids,
        previewToken: parsed.data.preview_token,
        requestId: parsed.data.request_id,
        motivo: parsed.data.motivo,
        metricasPorTrecho: parsed.data.metricas_por_trecho,
      }))
      app.audit?.log?.(request, {
        action: 'live.unir',
        entity_type: 'live_uniao',
        entity_id: result.uniao_id,
        metadata: { live_destino_id: result.live_id, origens: parsed.data.live_ids },
      })?.catch((error) => app.log.error({ err: error }, 'audit log failed'))
      invalidateTenant(request.user.tenant_id)
      invalidateHomeDashboard(request.user.tenant_id)
      return reply.code(201).send(result)
    } catch (error) {
      return handleMergeError(error, reply)
    }
  })

  app.get('/v1/lives/:id/uniao', { preHandler: managerAccess }, async (request, reply) => {
    const parsed = idParams.safeParse(request.params)
    if (!parsed.success) return validationError(reply, parsed)
    return app.withTenant(request.user.tenant_id, (db) => getLiveMergeHistory(db, {
      tenantId: request.user.tenant_id,
      liveId: parsed.data.id,
    }))
  })

  app.post('/v1/lives/uniao/:id/desfazer', { preHandler: managerAccess }, async (request, reply) => {
    const params = idParams.safeParse(request.params)
    const body = undoSchema.safeParse(request.body)
    if (!params.success) return validationError(reply, params)
    if (!body.success) return validationError(reply, body)
    try {
      const result = await app.withTenant(request.user.tenant_id, (db) => undoLiveMerge(db, {
        tenantId: request.user.tenant_id,
        userId: request.user.sub,
        unionId: params.data.id,
        requestId: body.data.request_id,
        motivo: body.data.motivo,
      }))
      app.audit?.log?.(request, {
        action: 'live.uniao_desfazer',
        entity_type: 'live_uniao',
        entity_id: params.data.id,
        metadata: { live_ids: result.live_ids },
      })?.catch((error) => app.log.error({ err: error }, 'audit log failed'))
      invalidateTenant(request.user.tenant_id)
      invalidateHomeDashboard(request.user.tenant_id)
      return result
    } catch (error) {
      return handleMergeError(error, reply)
    }
  })
}
