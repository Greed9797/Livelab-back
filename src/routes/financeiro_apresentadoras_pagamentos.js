import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { invalidateTenant } from '../lib/dashboard-cache.js'
import { DATA_RE, dataEhValida, MES_RE } from '../services/remuneracao-apresentadoras.js'
import {
  atualizarConfigVencimento, buscarConfigVencimento, cancelarPagamentoApresentadora, ehComponente, desfazerPagamentoApresentadora,
  listarPagamentosApresentadoras, reativarPagamentoApresentadora, registrarPagamentoApresentadora,
} from '../services/apresentadoras-pagamentos.js'

const pagarSchema = z.object({
  valor_pago: z.union([z.string(), z.number()]).optional(),
  data_pagamento: z.string().regex(DATA_RE).refine(dataEhValida, 'data_pagamento inválida').optional(),
  observacao: z.string().trim().max(500).optional(),
  chave_operacao: z.string().uuid().optional(),
}).strict()

const cancelarSchema = z.object({ motivo: z.string().trim().max(300).optional() }).strict()

// Erros de regra do serviço (409 CANCELAMENTO_INVALIDO / CUSTO_CANCELADO) e motivo > 300 (400).
const CODIGOS_409 = new Set(['CANCELAMENTO_INVALIDO', 'CUSTO_CANCELADO', 'APRESENTADORA_LIQUIDACAO_DIVERGENTE', 'APRESENTADORA_SEM_SALDO', 'APRESENTADORA_VALOR_EXCEDENTE', 'APRESENTADORA_PAGAMENTO_CONCORRENTE', 'APRESENTADORA_ESTORNO_GRANULAR_NECESSARIO', 'APRESENTADORA_ESTORNO_CONCORRENTE', 'FINANCEIRO_IDEMPOTENCIA_CONFLITO', 'FINANCEIRO_SALDO_INSUFICIENTE'])
const erroDeRegra = (err) => CODIGOS_409.has(err?.code) || err?.code === 'INVALID_MOTIVO'

const componenteCfg = z.object({
  dia: z.number().int().min(1).max(31).optional(),
  mes_offset: z.number().int().min(0).max(1).optional(),
}).strict()

// PATCH config: { fixo:{dia?,mes_offset?}, variavel:{dia?,mes_offset?} }.
// Compat (deprecado): { dia?, mes_offset? } plano = aplica ao FIXO.
const configSchema = z.object({
  fixo: componenteCfg.optional(),
  variavel: componenteCfg.optional(),
  dia: z.number().int().min(1).max(31).optional(),
  mes_offset: z.number().int().min(0).max(1).optional(),
}).strict()

const uuid = z.string().uuid()

export async function financeiroApresentadorasPagamentosRoutes(app) {
  const BASE = '/v1/financeiro/apresentadoras-pagamentos'

  function auditar(request, action, entityId, metadata) {
    app.audit?.log?.(request, { action, entity_type: 'apresentadora_pagamento', entity_id: entityId, metadata })
      ?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
  }

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
    if (!parsed.success) return reply.code(400).send({ error: 'Config inválida: dia (1-31) e mes_offset (0 ou 1) por componente' })
    const { fixo = {}, variavel = {}, dia, mes_offset: offset } = parsed.data
    const novo = {
      fixo: { dia: fixo.dia ?? dia, mes_offset: fixo.mes_offset ?? offset },
      variavel,
    }
    const algum = [novo.fixo.dia, novo.fixo.mes_offset, novo.variavel.dia, novo.variavel.mes_offset].some((v) => v !== undefined)
    if (!algum) return reply.code(400).send({ error: 'Informe fixo e/ou variavel com dia (1-31) e/ou mes_offset (0 ou 1)' })
    const tenantId = request.user.tenant_id
    return app.withTenant(tenantId, (db) => atualizarConfigVencimento(db, tenantId, {
      fixo: { dia: novo.fixo.dia ?? null, mes_offset: novo.fixo.mes_offset ?? null },
      variavel: { dia: novo.variavel.dia ?? null, mes_offset: novo.variavel.mes_offset ?? null },
    }))
  })

  // `componente` ausente = rota LEGADA (/:id/:mes/pagar). Decisão de compat: equivale a 'fixo' com
  // default = previsto do FIXO (nunca o total), para que a rota antiga não cubra o variável por engano
  // nem gere baixa dupla (a baixa é upsert por (tenant, apresentadora, competência, componente)).
  function validarParams(request, reply) {
    const { apresentadora_id: id, mes, componente = 'fixo' } = request.params
    if (!uuid.safeParse(id).success) { reply.code(400).send({ error: 'apresentadora_id inválido' }); return null }
    if (!MES_RE.test(mes)) { reply.code(400).send({ error: 'mes deve ter o formato YYYY-MM' }); return null }
    if (!ehComponente(componente)) { reply.code(400).send({ error: "componente deve ser 'fixo' ou 'variavel'" }); return null }
    if (request.params.componente === undefined) reply.header('Deprecation', 'true')
    return { id, mes, componente }
  }

  async function pagar(request, reply) {
    const p = validarParams(request, reply); if (!p) return
    const parsed = pagarSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const tenantId = request.user.tenant_id
    try {
      const pg = await app.withTenant(tenantId, (db) => registrarPagamentoApresentadora(db, {
        tenantId, apresentadoraId: p.id, mes: p.mes, componente: p.componente, valorPago: parsed.data.valor_pago,
        dataPagamento: parsed.data.data_pagamento, observacao: parsed.data.observacao, userId: request.user.sub,
        chaveOperacao: parsed.data.chave_operacao ?? randomUUID(),
      }))
      if (!pg) return reply.code(404).send({ error: 'Apresentadora não encontrada nesta unidade.' })
      // Trilha da baixa — inclusive quando quem paga é a chave de API financeira
      // (o plugin de audit marca via='api_key' e o nome da chave).
      auditar(request, 'financeiro.apresentadora_pagar', pg.id, {
        apresentadora_id: p.id, mes: p.mes, componente: p.componente,
        valor_pago: pg.valor_pago, data_pagamento: pg.data_pagamento,
      })
      invalidateTenant(tenantId)
      return pg
    } catch (err) {
      if (erroDeRegra(err)) return reply.code(err.statusCode ?? 409).send({ error: err.message, code: err.code })
      if (err instanceof TypeError) return reply.code(400).send({ error: 'valor_pago deve ser positivo com até duas casas decimais' })
      throw err
    }
  }

  async function desfazer(request, reply) {
    const p = validarParams(request, reply); if (!p) return
    const tenantId = request.user.tenant_id
    const chaveOperacao = request.body?.chave_operacao
    if (chaveOperacao != null && !uuid.safeParse(chaveOperacao).success) return reply.code(400).send({ error: 'chave_operacao inválida' })
    const ok = await app.withTenant(tenantId, (db) => desfazerPagamentoApresentadora(db, {
      tenantId, apresentadoraId: p.id, mes: p.mes, componente: p.componente, userId: request.user.sub,
      chaveOperacao: chaveOperacao ?? randomUUID(),
    }))
    if (!ok) return reply.code(404).send({ error: 'Nenhum pagamento registrado para esta competência.' })
    auditar(request, 'financeiro.apresentadora_desfazer', null, { apresentadora_id: p.id, mes: p.mes, componente: p.componente })
    invalidateTenant(tenantId)
    return { ok: true }
  }

  async function cancelar(request, reply) {
    const p = validarParams(request, reply); if (!p) return
    const parsed = cancelarSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const tenantId = request.user.tenant_id
    try {
      const item = await app.withTenant(tenantId, (db) => cancelarPagamentoApresentadora(db, {
        tenantId, apresentadoraId: p.id, mes: p.mes, componente: p.componente,
        motivo: parsed.data.motivo, actorUserId: request.user.sub ?? null,
      }))
      if (!item) return reply.code(404).send({ error: 'Apresentadora não encontrada nesta unidade.' })
      // entity_id é UUID: item.id é a chave virtual 'apresentadora:<uuid>:<mes>:<componente>' (vai no metadata).
      auditar(request, 'financeiro.apresentadora_cancelar', p.id, {
        item_id: item.id, apresentadora_id: p.id, mes: p.mes, componente: p.componente, motivo: item.cancelado_motivo ?? null,
      })
      invalidateTenant(tenantId)
      return item
    } catch (err) {
      if (erroDeRegra(err)) return reply.code(err.statusCode ?? 409).send({ error: err.message, code: err.code })
      throw err
    }
  }

  async function reativar(request, reply) {
    const p = validarParams(request, reply); if (!p) return
    const tenantId = request.user.tenant_id
    const item = await app.withTenant(tenantId, (db) => reativarPagamentoApresentadora(db, {
      tenantId, apresentadoraId: p.id, mes: p.mes, componente: p.componente,
    }))
    if (!item) return reply.code(404).send({ error: 'Nenhum cancelamento registrado para esta competência.' })
    auditar(request, 'financeiro.apresentadora_reativar', p.id, { item_id: item.id, apresentadora_id: p.id, mes: p.mes, componente: p.componente })
    invalidateTenant(tenantId)
    return item
  }

  const escrita = { preHandler: app.requirePapel(WRITE_FINANCEIRO) }
  app.patch(`${BASE}/:apresentadora_id/:mes/:componente/pagar`, escrita, pagar)
  app.patch(`${BASE}/:apresentadora_id/:mes/:componente/desfazer`, escrita, desfazer)
  app.patch(`${BASE}/:apresentadora_id/:mes/:componente/cancelar`, escrita, cancelar)
  app.patch(`${BASE}/:apresentadora_id/:mes/:componente/reativar`, escrita, reativar)
  // Legadas (deprecadas): sem componente = 'fixo'.
  app.patch(`${BASE}/:apresentadora_id/:mes/pagar`, escrita, pagar)
  app.patch(`${BASE}/:apresentadora_id/:mes/desfazer`, escrita, desfazer)
}
