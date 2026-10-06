import { READ_FINANCEIRO } from '../config/role_groups.js'
import { paginarExceptions, parseOverviewQuery, selecionarOverview } from '../services/financeiro-overview.js'

export async function financeiroOverviewRoutes(app) {
  const read = { preHandler: app.requirePapel(READ_FINANCEIRO) }

  async function selecionar(request, reply) {
    let options
    try {
      options = parseOverviewQuery(request.query ?? {})
    } catch (error) {
      return { error: reply.code(400).send({ error: error.message }) }
    }
    const tenantId = request.user?.tenant_id
    if (!tenantId) return { error: reply.code(403).send({ error: 'Tenant obrigatório' }) }
    reply.header('Cache-Control', 'no-store')
    const selection = await app.withTenant(tenantId, async (db) => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        const result = await selecionarOverview(db, { tenantId, ...options })
        await db.query('COMMIT')
        return result
      } catch (error) {
        try { await db.query('ROLLBACK') } catch (rollbackError) { app.log.error({ err: rollbackError }, 'financeiro overview rollback failed') }
        throw error
      }
    })
    return { selection, options }
  }

  app.get('/v1/financeiro/overview', read, async (request, reply) => {
    const result = await selecionar(request, reply)
    if (result.error) return result.error
    const { exceptions, ...overview } = result.selection
    return { ...overview, total_excecoes: exceptions.length }
  })

  app.get('/v1/financeiro/exceptions', read, async (request, reply) => {
    const result = await selecionar(request, reply)
    if (result.error) return result.error
    return paginarExceptions(result.selection, result.options)
  })
}
