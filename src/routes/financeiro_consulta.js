import { READ_FINANCEIRO } from '../config/role_groups.js'
import { consultaCsv, paginarConsulta, parseConsultaQuery, selecionarConsulta } from '../services/financeiro-consulta.js'
import { detalhesReconciliacao } from '../lib/financeiro-error-details.js'

export async function financeiroConsultaRoutes(app) {
  const read = { preHandler: app.requirePapel(READ_FINANCEIRO) }

  async function selecionar(request, reply) {
    let options
    try {
      options = parseConsultaQuery(request.query ?? {})
    } catch (error) {
      return { error: reply.code(400).send({ error: error.message }) }
    }
    const tenantId = request.user.tenant_id
    // O agregador faz várias leituras. Uma conexão com snapshot estável evita
    // misturar antes/depois de uma baixa nos itens e totais da mesma resposta.
    const selection = await app.withTenant(tenantId, async (db) => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        const result = await selecionarConsulta(db, { tenantId, filtros: options.filtros })
        await db.query('COMMIT')
        return result
      } catch (error) {
        try { await db.query('ROLLBACK') } catch (rollbackError) { app.log.error({ err: rollbackError }, 'financeiro consulta rollback failed') }
        throw error
      }
    }).catch(error => {
      if (error?.code !== 'FINANCIAL_RECONCILIATION_REQUIRED' || error.statusCode !== 409) throw error
      reply.code(409).send({ error: error.message, code: error.code, ...detalhesReconciliacao(error) })
      return null
    })
    return reply.sent ? { error: reply } : { selection, options }
  }

  app.get('/v1/financeiro/consulta', read, async (request, reply) => {
    const result = await selecionar(request, reply)
    if (result.error) return result.error
    return paginarConsulta(result.selection, result.options)
  })

  app.get('/v1/financeiro/consulta.csv', read, async (request, reply) => {
    const result = await selecionar(request, reply)
    if (result.error) return result.error
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', 'attachment; filename="financeiro-consulta.csv"')
    reply.header('Cache-Control', 'no-store')
    return consultaCsv(result.selection)
  })
}
