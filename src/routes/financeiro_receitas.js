// Receitas (títulos a receber) derivadas do COMERCIAL — ver services/receitas-comercial.js.
//   GET   /v1/financeiro/receita?mes=AAAA-MM   (aba Receita: competência × vencimento,
//         a_receber_mes; ver montarReceitaMensal)
//   GET   /v1/financeiro/receitas?inicio=AAAA-MM&fim=AAAA-MM | ?mes=AAAA-MM
//         [&status=previsto|pendente|atrasado|parcial|pago|perdido&marca_id=&cliente_id=&componente=fixo|comissao]
//   POST  /v1/financeiro/receitas/gerar?mes=AAAA-MM
//   PATCH /v1/financeiro/receitas/:id/receber   { valor_pago?, data_pagamento?, observacao? }
//   PATCH /v1/financeiro/receitas/:id/desfazer
//   PATCH /v1/financeiro/receitas/:id/perder     { motivo? (≤300) }  → status 'perdido' (migration 173)
//   PATCH /v1/financeiro/receitas/:id/desperder  → remove a perda
//   (receber título perdido → 409; perder título 100% pago → 409)
// `:id` aceita uuid (título materializado) ou `calc:<marca_id>:<AAAA-MM>:<fixo|comissao>`
// (título ainda só calculado — a baixa o materializa).
import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'
import { MOTIVO_MAX, STATUS_LANCAMENTO } from '../lib/lancamento-status.js'
import {
  COMPONENTES_RECEITA,
  consultarReceitaMensal,
  desfazerRecebimento,
  desperderTitulo,
  gerarTitulosReceita,
  hojeSaoPaulo,
  listarTitulosReceita,
  perderTitulo,
  receberTitulo,
  totalizarTitulos,
} from '../services/receitas-comercial.js'

const mesRegex = /^\d{4}-(0[1-9]|1[0-2])$/

const listarQuerySchema = z.object({
  mes: z.string().regex(mesRegex, 'mes deve estar no formato AAAA-MM').optional(),
  inicio: z.string().regex(mesRegex, 'inicio deve estar no formato AAAA-MM').optional(),
  fim: z.string().regex(mesRegex, 'fim deve estar no formato AAAA-MM').optional(),
  status: z.enum(STATUS_LANCAMENTO).optional(),
  componente: z.enum(COMPONENTES_RECEITA).optional(),
  marca_id: z.string().uuid('marca_id inválido').optional(),
  cliente_id: z.string().uuid('cliente_id inválido').optional(),
})

const receitaMensalQuerySchema = z.object({
  mes: z.string().regex(mesRegex, 'mes deve estar no formato AAAA-MM').optional(),
})

const gerarSchema = z.object({
  mes: z.string({ error: 'mes é obrigatório (AAAA-MM)' }).regex(mesRegex, 'mes deve estar no formato AAAA-MM'),
})

const receberSchema = z.object({
  valor_pago: moneySchema.refine((v) => v > 0, 'valor_pago deve ser maior que zero').optional(),
  data_pagamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data_pagamento deve estar no formato AAAA-MM-DD').optional(),
  observacao: z.string().max(500).nullable().optional(),
}).strict()

const perderSchema = z.object({
  motivo: z.string().max(MOTIVO_MAX, `motivo deve ter no máximo ${MOTIVO_MAX} caracteres`).nullish(),
}).strict()

function erro(reply, error) {
  if (error?.statusCode && error.statusCode < 500) {
    return reply.code(error.statusCode).send({ code: error.code, error: error.message })
  }
  throw error
}

export async function financeiroReceitasRoutes(app) {
  const read = [app.authenticate, app.requirePapel(READ_FINANCEIRO)]
  const write = [app.authenticate, app.requirePapel(WRITE_FINANCEIRO)]

  app.get('/v1/financeiro/receita', { preHandler: read }, async (request, reply) => {
    const parsed = receitaMensalQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const hoje = hojeSaoPaulo()
    const mes = parsed.data.mes ?? hoje.slice(0, 7)
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        return await consultarReceitaMensal(db, { tenantId: tenant_id, mes, hoje })
      } catch (error) {
        return erro(reply, error)
      }
    })
  })

  app.get('/v1/financeiro/receitas', { preHandler: read }, async (request, reply) => {
    const parsed = listarQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const q = parsed.data
    const hoje = hojeSaoPaulo()
    const inicio = q.inicio ?? q.mes ?? hoje.slice(0, 7)
    const fim = q.fim ?? (q.inicio ? q.inicio : inicio)
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const itens = await listarTitulosReceita(db, {
          tenantId: tenant_id, inicio, fim, hoje,
          status: q.status, marca_id: q.marca_id, cliente_id: q.cliente_id, componente: q.componente,
        })
        return { inicio, fim, hoje, itens, totais: totalizarTitulos(itens) }
      } catch (error) {
        return erro(reply, error)
      }
    })
  })

  app.post('/v1/financeiro/receitas/gerar', { preHandler: write }, async (request, reply) => {
    const parsed = gerarSchema.safeParse({ mes: request.query?.mes ?? request.body?.mes })
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const result = await gerarTitulosReceita(db, { tenantId: tenant_id, mes: parsed.data.mes, actorUserId: sub ?? null })
        app.audit?.log?.(request, {
          action: 'receita_titulos.gerar', entity_type: 'receita_titulos', entity_id: null,
          metadata: {
            mes: result.mes, criados: result.criados, atualizados: result.atualizados, removidos: result.removidos,
            perdidos_preservados: result.perdidos_preservados,
          },
        })?.catch((err) => app.log.error({ err }, 'audit log failed'))
        return { ...result, totais: totalizarTitulos(result.itens) }
      } catch (error) {
        return erro(reply, error)
      }
    })
  })

  app.patch('/v1/financeiro/receitas/:id/receber', { preHandler: write }, async (request, reply) => {
    const parsed = receberSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const titulo = await receberTitulo(db, {
          tenantId: tenant_id,
          id: request.params.id,
          valorPago: parsed.data.valor_pago,
          dataPagamento: parsed.data.data_pagamento,
          observacao: parsed.data.observacao,
          actorUserId: sub ?? null,
        })
        app.audit?.log?.(request, {
          action: 'receita_titulo.receber', entity_type: 'receita_titulo', entity_id: titulo?.id ?? null,
          metadata: { valor_pago: titulo?.valor_pago, data_pagamento: titulo?.data_pagamento },
        })?.catch((err) => app.log.error({ err }, 'audit log failed'))
        return titulo
      } catch (error) {
        return erro(reply, error)
      }
    })
  })

  app.patch('/v1/financeiro/receitas/:id/desfazer', { preHandler: write }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const titulo = await desfazerRecebimento(db, { tenantId: tenant_id, id: request.params.id })
        app.audit?.log?.(request, {
          action: 'receita_titulo.desfazer', entity_type: 'receita_titulo', entity_id: titulo?.id ?? null, metadata: {},
        })?.catch((err) => app.log.error({ err }, 'audit log failed'))
        return titulo
      } catch (error) {
        return erro(reply, error)
      }
    })
  })

  app.patch('/v1/financeiro/receitas/:id/perder', { preHandler: write }, async (request, reply) => {
    const parsed = perderSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const { item, ja_perdido: jaPerdido } = await perderTitulo(db, {
          tenantId: tenant_id, id: request.params.id, motivo: parsed.data.motivo, actorUserId: sub ?? null,
        })
        app.audit?.log?.(request, {
          action: 'receita_titulo.perder', entity_type: 'receita_titulo', entity_id: item?.id ?? null,
          metadata: {
            id_informado: request.params.id, motivo: item?.perdido_motivo ?? null, ja_perdido: jaPerdido,
            valor_previsto: item?.valor_previsto, valor_pago: item?.valor_pago,
          },
        })?.catch((err) => app.log.error({ err }, 'audit log failed'))
        return item
      } catch (error) {
        return erro(reply, error)
      }
    })
  })

  app.patch('/v1/financeiro/receitas/:id/desperder', { preHandler: write }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const { item, estava_perdido: estavaPerdido } = await desperderTitulo(db, { tenantId: tenant_id, id: request.params.id })
        app.audit?.log?.(request, {
          action: 'receita_titulo.desperder', entity_type: 'receita_titulo', entity_id: item?.id ?? null,
          metadata: { id_informado: request.params.id, estava_perdido: estavaPerdido },
        })?.catch((err) => app.log.error({ err }, 'audit log failed'))
        return item
      } catch (error) {
        return erro(reply, error)
      }
    })
  })
}
