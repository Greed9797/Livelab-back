import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { DATA_RE, dataEhValida, MES_RE } from '../services/remuneracao-apresentadoras.js'
import {
  buscarConfigVencimento, desfazerPagamentoApresentadora, listarPagamentosApresentadoras,
  registrarPagamentoApresentadora,
} from '../services/apresentadoras-pagamentos.js'

const pagarSchema = z.object({
  valor_pago: z.union([z.string(), z.number()]).optional(),
  data_pagamento: z.string().regex(DATA_RE).refine(dataEhValida, 'data_pagamento inválida').optional(),
  observacao: z.string().trim().max(500).optional(),
}).strict()

const configSchema = z.object({
  dia: z.number().int().min(1).max(31).optional(),
  mes_offset: z.number().int().min(0).max(1).optional(),
}).strict()

const uuid = z.string().uuid()

export async function financeiroApresentadorasPagamentosRoutes(app) {
  const BASE = '/v1/financeiro/apresentadoras-pagamentos'

  app.get(BASE, { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request, reply) => {
    const { mes, inicio, fim } = request.query ?? {}
    let de = inicio, ate = fim
    if (mes) {
      if (!MES_RE.test(String(mes))) return reply.code(400).send({ error: 'mes deve ter o formato YYYY-MM' })
      de = `${mes}-01`; ate = `${mes}-01`
    }
    if (!de || !ate || !dataEhValida(String(de)) || !dataEhValida(String(ate)) || de > ate) {
      return reply.code(400).send({ error: 'Informe mes=YYYY-MM ou inicio/fim (YYYY-MM-DD) válidos' })
    }
    const tenantId = request.user.tenant_id
    const itens = await app.withTenant(tenantId, (db) => listarPagamentosApresentadoras(db, { tenantId, inicio: de, fim: ate }))
    return { itens, pode_editar: WRITE_FINANCEIRO.includes(request.user.papel) }
  })

  app.get(`${BASE}/config`, { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const tenantId = request.user.tenant_id
    return app.withTenant(tenantId, (db) => buscarConfigVencimento(db, tenantId))
  })

  app.patch(`${BASE}/config`, { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const parsed = configSchema.safeParse(request.body ?? {})
    if (!parsed.success || (parsed.data.dia === undefined && parsed.data.mes_offset === undefined)) {
      return reply.code(400).send({ error: 'Informe dia (1-31) e/ou mes_offset (0 ou 1)' })
    }
    const tenantId = request.user.tenant_id
    return app.withTenant(tenantId, async (db) => {
      await db.query(
        `UPDATE tenants SET apresentadoras_vencimento_dia = COALESCE($2::smallint, apresentadoras_vencimento_dia),
                            apresentadoras_vencimento_mes_offset = COALESCE($3::smallint, apresentadoras_vencimento_mes_offset)
          WHERE id = $1::uuid`,
        [tenantId, parsed.data.dia ?? null, parsed.data.mes_offset ?? null])
      return buscarConfigVencimento(db, tenantId)
    })
  })

  function validarParams(request, reply) {
    const { apresentadora_id: id, mes } = request.params
    if (!uuid.safeParse(id).success) { reply.code(400).send({ error: 'apresentadora_id inválido' }); return null }
    if (!MES_RE.test(mes)) { reply.code(400).send({ error: 'mes deve ter o formato YYYY-MM' }); return null }
    return { id, mes }
  }

  app.patch(`${BASE}/:apresentadora_id/:mes/pagar`, { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const p = validarParams(request, reply); if (!p) return
    const parsed = pagarSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const tenantId = request.user.tenant_id
    try {
      const pg = await app.withTenant(tenantId, (db) => registrarPagamentoApresentadora(db, {
        tenantId, apresentadoraId: p.id, mes: p.mes, valorPago: parsed.data.valor_pago,
        dataPagamento: parsed.data.data_pagamento, observacao: parsed.data.observacao, userId: request.user.sub,
      }))
      if (!pg) return reply.code(404).send({ error: 'Apresentadora não encontrada nesta unidade.' })
      return pg
    } catch (err) {
      if (err instanceof TypeError) return reply.code(400).send({ error: 'valor_pago deve ser positivo com até duas casas decimais' })
      throw err
    }
  })

  app.patch(`${BASE}/:apresentadora_id/:mes/desfazer`, { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const p = validarParams(request, reply); if (!p) return
    const tenantId = request.user.tenant_id
    const ok = await app.withTenant(tenantId, (db) => desfazerPagamentoApresentadora(db, { tenantId, apresentadoraId: p.id, mes: p.mes }))
    if (!ok) return reply.code(404).send({ error: 'Nenhum pagamento registrado para esta competência.' })
    return { ok: true }
  })
}
