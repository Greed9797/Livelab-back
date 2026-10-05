import { z } from 'zod'
import { consultarFechamento, mudarFechamento } from '../services/financeiro-fechamentos.js'
import { hojeSaoPaulo } from '../services/financeiro-agregador.js'

const mesSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
const motivoSchema = z.object({ motivo: z.string().trim().min(1).max(500) }).strict()
const vazioSchema = z.object({}).strict()

export async function financeiroFechamentosRoutes(app) {
  const leitura = app.requirePapel(['financeiro', 'franqueador_master', 'financeiro_readonly', 'auditor'])
  const fechamento = app.requirePapel(['financeiro', 'franqueador_master'])
  const reabertura = app.requirePapel('franqueador_master')

  const validarMes = (request, reply) => {
    const parsed = mesSchema.safeParse(request.params.mes)
    if (!parsed.success) reply.code(400).send({ error: 'mes deve ter o formato AAAA-MM' })
    return parsed.success ? parsed.data : null
  }

  app.get('/v1/financeiro/fechamentos/:mes', { preHandler: leitura }, async (request, reply) => {
    const mes = validarMes(request, reply)
    if (!mes) return reply
    return app.withTenant(request.user.tenant_id, (db) => consultarFechamento(db, { tenantId: request.user.tenant_id, mes }))
  })

  async function executar(request, reply, evento) {
    const mes = validarMes(request, reply)
    if (!mes) return reply
    const parsed = (evento === 'reabertura' ? motivoSchema : vazioSchema).safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    try {
      return await app.withTenant(request.user.tenant_id, (db) => mudarFechamento(db, {
        tenantId: request.user.tenant_id, mes, actorUserId: request.user.sub,
        evento, motivo: parsed.data.motivo ?? null, hoje: hojeSaoPaulo(),
      }))
    } catch (error) {
      if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.message })
      throw error
    }
  }

  app.post('/v1/financeiro/fechamentos/:mes', { preHandler: fechamento },
    (request, reply) => executar(request, reply, 'fechamento'))
  app.post('/v1/financeiro/fechamentos/:mes/reabrir', { preHandler: reabertura },
    (request, reply) => executar(request, reply, 'reabertura'))
}
