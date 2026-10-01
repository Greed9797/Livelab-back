import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { DATA_RE, dataEhValida, MES_RE } from '../services/remuneracao-apresentadoras.js'
import {
  atualizarConfigVencimento, buscarConfigVencimento, ehComponente, desfazerPagamentoApresentadora, listarPagamentosApresentadoras,
  registrarPagamentoApresentadora,
} from '../services/apresentadoras-pagamentos.js'

const pagarSchema = z.object({
  valor_pago: z.union([z.string(), z.number()]).optional(),
  data_pagamento: z.string().regex(DATA_RE).refine(dataEhValida, 'data_pagamento inválida').optional(),
  observacao: z.string().trim().max(500).optional(),
}).strict()

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
      }))
      if (!pg) return reply.code(404).send({ error: 'Apresentadora não encontrada nesta unidade.' })
      // Trilha da baixa — inclusive quando quem paga é a chave de API financeira
      // (o plugin de audit marca via='api_key' e o nome da chave).
      auditar(request, 'financeiro.apresentadora_pagar', pg.id, {
        apresentadora_id: p.id, mes: p.mes, componente: p.componente,
        valor_pago: pg.valor_pago, data_pagamento: pg.data_pagamento,
      })
      return pg
    } catch (err) {
      if (err instanceof TypeError) return reply.code(400).send({ error: 'valor_pago deve ser positivo com até duas casas decimais' })
      throw err
    }
  }

  async function desfazer(request, reply) {
    const p = validarParams(request, reply); if (!p) return
    const tenantId = request.user.tenant_id
    const ok = await app.withTenant(tenantId, (db) => desfazerPagamentoApresentadora(db, { tenantId, apresentadoraId: p.id, mes: p.mes, componente: p.componente }))
    if (!ok) return reply.code(404).send({ error: 'Nenhum pagamento registrado para esta competência.' })
    auditar(request, 'financeiro.apresentadora_desfazer', null, { apresentadora_id: p.id, mes: p.mes, componente: p.componente })
    return { ok: true }
  }

  const escrita = { preHandler: app.requirePapel(WRITE_FINANCEIRO) }
  app.patch(`${BASE}/:apresentadora_id/:mes/:componente/pagar`, escrita, pagar)
  app.patch(`${BASE}/:apresentadora_id/:mes/:componente/desfazer`, escrita, desfazer)
  // Legadas (deprecadas): sem componente = 'fixo'.
  app.patch(`${BASE}/:apresentadora_id/:mes/pagar`, escrita, pagar)
  app.patch(`${BASE}/:apresentadora_id/:mes/desfazer`, escrita, desfazer)
}
