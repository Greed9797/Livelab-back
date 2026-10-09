import { z } from 'zod'
import { WRITE_FINANCEIRO } from '../config/role_groups.js'
import { exactMoneyToCents } from '../lib/money.js'
import { invalidateTenant } from '../lib/dashboard-cache.js'
import { registrarBaixaIncremental } from '../services/financeiro-liquidacoes-incrementais.js'

const dataValida = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}
const data = z.string().refine(dataValida, 'data deve estar no formato AAAA-MM-DD e ser válida')
const valor = z.union([z.string(), z.number()]).superRefine((value, ctx) => {
  try {
    if (exactMoneyToCents(value) <= 0n) ctx.addIssue({ code: 'custom', message: 'valor_operacao deve ser maior que zero' })
  } catch { ctx.addIssue({ code: 'custom', message: 'valor_operacao deve ser decimal com até duas casas' }) }
})

const schema = z.object({
  tipo: z.enum(['receita', 'avulsa', 'custo', 'apresentadora', 'imposto']),
  id: z.string().trim().min(1).max(200),
  valor_operacao: valor,
  data,
  chave_operacao: z.string().uuid('chave_operacao deve ser UUID válido'),
  observacao: z.string().trim().max(500).nullable().optional(),
}).strict()

const hojeSaoPaulo = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())

export async function financeiroLiquidacoesIncrementaisRoutes(app) {
  app.post('/v1/financeiro/liquidacoes/incrementais', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_FINANCEIRO)],
  }, async (request, reply) => {
    const parsed = schema.safeParse(request.body ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: `${issue.path.join('.') || 'payload'}: ${issue.message}` })
    }
    const body = parsed.data
    const { tenant_id: tenantId, sub } = request.user
    try {
      const result = await app.withTenant(tenantId, (db) => registrarBaixaIncremental(db, {
        tenantId,
        tipo: body.tipo,
        id: body.id,
        valorOperacao: body.valor_operacao,
        data: body.data,
        chaveOperacao: body.chave_operacao,
        observacao: body.observacao ?? null,
        ator: { tipo: request.viaApiKey ? 'api_key' : 'usuario', id: request.viaApiKey?.id ?? sub },
        hoje: hojeSaoPaulo(),
      }))
      invalidateTenant(tenantId)
      app.audit?.log?.(request, {
        action: 'financeiro.liquidacao_incremental',
        entity_type: 'financeiro_liquidacao',
        entity_id: result.liquidacao_id,
        metadata: {
          tipo: body.tipo, origem_id: result.origem_id, valor_operacao: result.valor_operacao,
          data: result.data, replay: result.replay, situacao_data: result.situacao_data,
        },
      })?.catch?.((error) => app.log.error({ error }, 'audit log failed'))
      return result
    } catch (error) {
      if (Number.isInteger(error?.statusCode) && error.statusCode < 500) {
        return reply.code(error.statusCode).send({ code: error.code, error: error.message })
      }
      throw error
    }
  })
}
