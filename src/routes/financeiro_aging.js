import { READ_FINANCEIRO } from '../config/role_groups.js'
import { parseAgingQuery, selecionarAging } from '../services/financeiro-aging.js'

export async function financeiroAgingRoutes(app) {
  app.get('/v1/financeiro/aging', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request, reply) => {
    let options
    try {
      options = parseAgingQuery(request.query ?? {})
    } catch (error) {
      return reply.code(400).send({ error: error.message })
    }
    const tenantId = request.user?.tenant_id
    if (!tenantId) return reply.code(403).send({ error: 'Tenant obrigatório' })
    reply.header('Cache-Control', 'no-store')
    return app.withTenant(tenantId, async (db) => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        const result = await selecionarAging(db, { tenantId, ...options })
        await db.query('COMMIT')
        return result
      } catch (error) {
        try { await db.query('ROLLBACK') } catch (rollbackError) { app.log.error({ err: rollbackError }, 'financeiro aging rollback failed') }
        throw error
      }
    })
  })
}
