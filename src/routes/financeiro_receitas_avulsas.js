// Receitas avulsas (fora das marcas) — ver services/receitas-avulsas.js.
// Permissões: READ_FINANCEIRO (GET) / WRITE_FINANCEIRO (demais). Registrar em src/app.js.
//
//   GET    /v1/financeiro/receitas-avulsas?mes=AAAA-MM | inicio=AAAA-MM&fim=AAAA-MM [&grupo=&status=]
//   POST   /v1/financeiro/receitas-avulsas            { descricao, grupo?, valor_previsto, data_vencimento,
//                                                       competencia?, observacao?, valor_pago?, data_pagamento? }
//   PATCH  /v1/financeiro/receitas-avulsas/:id        { descricao?, grupo?, valor_previsto?, data_vencimento?,
//                                                       competencia?, observacao? }
//   DELETE /v1/financeiro/receitas-avulsas/:id
//   PATCH  /v1/financeiro/receitas-avulsas/:id/receber   { valor_pago?, data_pagamento? }
//   PATCH  /v1/financeiro/receitas-avulsas/:id/desfazer
//   PATCH  /v1/financeiro/receitas-avulsas/:id/perder     { motivo? (≤300) } → status 'perdido' (migration 173)
//   PATCH  /v1/financeiro/receitas-avulsas/:id/desperder
//   (receber receita perdida → 409; perder receita 100% recebida → 409)
//
// Grupo 'aporte' = entrada de caixa fora da receita operacional (DRE) e da base do imposto.
import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'
import { MOTIVO_MAX, STATUS_LANCAMENTO } from '../lib/lancamento-status.js'
import { invalidateTenant } from '../lib/dashboard-cache.js'
import { dataValida } from '../services/financeiro-agregador.js'
import {
  GRUPOS_RECEITA_AVULSA, criarReceitaAvulsa, desfazerReceitaAvulsa, desperderReceitaAvulsa,
  editarReceitaAvulsa, excluirReceitaAvulsa, hojeSaoPaulo, listarReceitasAvulsas, perderReceitaAvulsa,
  receberReceitaAvulsa,
} from '../services/receitas-avulsas.js'

const mesRegex = /^\d{4}-(0[1-9]|1[0-2])$/
const dataSchema = z.string().refine(dataValida, 'Data inválida (AAAA-MM-DD)')
const competenciaSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/, 'competencia: AAAA-MM ou AAAA-MM-DD')
const positivo = moneySchema.refine((v) => v > 0, 'Valor deve ser maior que zero')
const UUID = z.string().uuid()

const listarQuerySchema = z.object({
  mes: z.string().regex(mesRegex, 'mes deve estar no formato AAAA-MM').optional(),
  inicio: z.string().regex(mesRegex, 'inicio deve estar no formato AAAA-MM').optional(),
  fim: z.string().regex(mesRegex, 'fim deve estar no formato AAAA-MM').optional(),
  grupo: z.enum(GRUPOS_RECEITA_AVULSA).optional(),
  status: z.enum(STATUS_LANCAMENTO).optional(),
})

const criarSchema = z.object({
  descricao: z.string().trim().min(1, 'descricao é obrigatória').max(300),
  grupo: z.enum(GRUPOS_RECEITA_AVULSA).default('outros'),
  valor_previsto: positivo,
  data_vencimento: dataSchema,
  competencia: competenciaSchema.optional(),
  observacao: z.string().max(1000).nullish(),
  valor_pago: moneySchema.optional(),
  data_pagamento: dataSchema.optional(),
}).strict()

const editarSchema = z.object({
  descricao: z.string().trim().min(1).max(300),
  grupo: z.enum(GRUPOS_RECEITA_AVULSA),
  valor_previsto: positivo,
  data_vencimento: dataSchema,
  competencia: competenciaSchema,
  observacao: z.string().max(1000).nullable(),
}).partial().strict().refine((d) => Object.keys(d).length > 0, { message: 'Nada para atualizar' })

const receberSchema = z.object({
  valor_pago: positivo.optional(),
  data_pagamento: dataSchema.optional(),
}).strict()

const perderSchema = z.object({
  motivo: z.string().max(MOTIVO_MAX, `motivo deve ter no máximo ${MOTIVO_MAX} caracteres`).nullish(),
}).strict()

function responderErro(reply, error) {
  if (error?.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ code: error.code, error: error.message })
  throw error
}

function auditar(app, request, action, entityId, metadata) {
  app.audit?.log?.(request, { action, entity_type: 'receita_avulsa', entity_id: entityId, metadata })
    ?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
}

const NAO_ENCONTRADA = { code: 'RECEITA_AVULSA_NOT_FOUND', error: 'Receita avulsa não encontrada' }

export async function financeiroReceitasAvulsasRoutes(app) {
  const READ = { preHandler: app.requirePapel(READ_FINANCEIRO) }
  const WRITE = { preHandler: app.requirePapel(WRITE_FINANCEIRO) }

  app.get('/v1/financeiro/receitas-avulsas', READ, async (request, reply) => {
    const parsed = listarQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const q = parsed.data
    const hoje = hojeSaoPaulo()
    const inicio = q.inicio ?? q.mes ?? hoje.slice(0, 7)
    const fim = q.fim ?? (q.inicio ? q.inicio : inicio)
    if (fim < inicio) return reply.code(400).send({ error: 'fim deve ser maior ou igual a inicio' })
    const { tenant_id } = request.user
    try {
      const itens = await app.withTenant(tenant_id, (db) => listarReceitasAvulsas(db, {
        tenantId: tenant_id, inicio, fim, hoje, grupo: q.grupo, status: q.status,
      }))
      const soma = (k, f = () => true) => Math.round(itens.filter(f).reduce((s, i) => s + i[k], 0) * 100) / 100
      return {
        inicio, fim, hoje, itens,
        totais: {
          previsto: soma('valor_previsto'),
          pago: soma('valor_pago'),
          aportes: { previsto: soma('valor_previsto', (i) => i.aporte), pago: soma('valor_pago', (i) => i.aporte) },
        },
      }
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  app.post('/v1/financeiro/receitas-avulsas', WRITE, async (request, reply) => {
    const parsed = criarSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id, sub } = request.user
    try {
      const item = await app.withTenant(tenant_id, (db) => criarReceitaAvulsa(db, {
        tenantId: tenant_id, dados: parsed.data, hoje: hojeSaoPaulo(), actorUserId: sub ?? null,
      }))
      invalidateTenant(tenant_id)
      auditar(app, request, 'receita_avulsa.criar', item.id, parsed.data)
      return reply.code(201).send(item)
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  app.patch('/v1/financeiro/receitas-avulsas/:id', WRITE, async (request, reply) => {
    if (!UUID.safeParse(request.params.id).success) return reply.code(400).send({ error: 'id inválido' })
    const parsed = editarSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    try {
      const item = await app.withTenant(tenant_id, (db) => editarReceitaAvulsa(db, {
        tenantId: tenant_id, id: request.params.id, dados: parsed.data, hoje: hojeSaoPaulo(),
      }))
      if (!item) return reply.code(404).send(NAO_ENCONTRADA)
      invalidateTenant(tenant_id)
      auditar(app, request, 'receita_avulsa.editar', item.id, parsed.data)
      return item
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  app.delete('/v1/financeiro/receitas-avulsas/:id', WRITE, async (request, reply) => {
    if (!UUID.safeParse(request.params.id).success) return reply.code(400).send({ error: 'id inválido' })
    const { tenant_id } = request.user
    const ok = await app.withTenant(tenant_id, (db) => excluirReceitaAvulsa(db, { tenantId: tenant_id, id: request.params.id }))
    if (!ok) return reply.code(404).send(NAO_ENCONTRADA)
    invalidateTenant(tenant_id)
    auditar(app, request, 'receita_avulsa.excluir', request.params.id, {})
    return reply.code(204).send()
  })

  app.patch('/v1/financeiro/receitas-avulsas/:id/receber', WRITE, async (request, reply) => {
    if (!UUID.safeParse(request.params.id).success) return reply.code(400).send({ error: 'id inválido' })
    const parsed = receberSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    try {
      const item = await app.withTenant(tenant_id, (db) => receberReceitaAvulsa(db, {
        tenantId: tenant_id, id: request.params.id, valorPago: parsed.data.valor_pago,
        dataPagamento: parsed.data.data_pagamento, hoje: hojeSaoPaulo(),
      }))
      if (!item) return reply.code(404).send(NAO_ENCONTRADA)
      invalidateTenant(tenant_id)
      auditar(app, request, 'receita_avulsa.receber', item.id, { valor_pago: item.valor_pago, data_pagamento: item.data_pagamento })
      return item
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  app.patch('/v1/financeiro/receitas-avulsas/:id/desfazer', WRITE, async (request, reply) => {
    if (!UUID.safeParse(request.params.id).success) return reply.code(400).send({ error: 'id inválido' })
    const { tenant_id } = request.user
    const item = await app.withTenant(tenant_id, (db) => desfazerReceitaAvulsa(db, {
      tenantId: tenant_id, id: request.params.id, hoje: hojeSaoPaulo(),
    }))
    if (!item) return reply.code(404).send(NAO_ENCONTRADA)
    invalidateTenant(tenant_id)
    auditar(app, request, 'receita_avulsa.desfazer', item.id, {})
    return item
  })

  app.patch('/v1/financeiro/receitas-avulsas/:id/perder', WRITE, async (request, reply) => {
    if (!UUID.safeParse(request.params.id).success) return reply.code(400).send({ error: 'id inválido' })
    const parsed = perderSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id, sub } = request.user
    try {
      const res = await app.withTenant(tenant_id, (db) => perderReceitaAvulsa(db, {
        tenantId: tenant_id, id: request.params.id, motivo: parsed.data.motivo, actorUserId: sub ?? null, hoje: hojeSaoPaulo(),
      }))
      if (!res) return reply.code(404).send(NAO_ENCONTRADA)
      invalidateTenant(tenant_id)
      auditar(app, request, 'receita_avulsa.perder', res.item.id, {
        motivo: res.item.perdido_motivo, ja_perdido: res.ja_perdido,
        valor_previsto: res.item.valor_previsto, valor_pago: res.item.valor_pago,
      })
      return res.item
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  app.patch('/v1/financeiro/receitas-avulsas/:id/desperder', WRITE, async (request, reply) => {
    if (!UUID.safeParse(request.params.id).success) return reply.code(400).send({ error: 'id inválido' })
    const { tenant_id } = request.user
    try {
      const res = await app.withTenant(tenant_id, (db) => desperderReceitaAvulsa(db, {
        tenantId: tenant_id, id: request.params.id, hoje: hojeSaoPaulo(),
      }))
      if (!res) return reply.code(404).send(NAO_ENCONTRADA)
      invalidateTenant(tenant_id)
      auditar(app, request, 'receita_avulsa.desperder', res.item.id, { estava_perdido: res.estava_perdido })
      return res.item
    } catch (error) {
      return responderErro(reply, error)
    }
  })
}
