import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import {
  buscarFechamentoApresentadoras, buscarHistoricoLivesApresentadora, competenciaDoMes, dataEhFimDeSemana,
  dataEhValida, dinheiroEmCentavos, MES_RE,
} from '../services/remuneracao-apresentadoras.js'

const adicionalSchema = z.object({
  mes: z.string().regex(MES_RE, 'mes deve ter o formato YYYY-MM'),
  apresentadora_id: z.string().uuid('apresentadora_id inválido'),
  tipo: z.enum(['fim_de_semana', 'bonificacao']),
  descricao: z.string().trim().min(1, 'Descrição é obrigatória').max(300),
  data_referencia: z.string().optional(),
  valor: z.union([z.string(), z.number()]).optional(),
  request_id: z.string().uuid('request_id inválido').optional(),
})

function erroBanco(err) {
  if (err?.code === '23505') return 'Esta diária de fim de semana já foi lançada para a apresentadora.'
  if (err?.code === '23503') return 'Apresentadora não encontrada nesta unidade.'
  return null
}

export async function remuneracaoApresentadorasRoutes(app) {
  app.get('/v1/financeiro/fechamento-apresentadoras', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request, reply) => {
    const mes = String(request.query?.mes ?? '')
    if (!MES_RE.test(mes)) return reply.code(400).send({ error: 'mes deve ter o formato YYYY-MM' })
    const fechamento = await app.withTenant(request.user.tenant_id, (db) => buscarFechamentoApresentadoras(db, { tenantId: request.user.tenant_id, mes }))
    return { ...fechamento, pode_editar: WRITE_FINANCEIRO.includes(request.user.papel) }
  })

  app.get('/v1/financeiro/fechamento-apresentadoras/:id/detalhes', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request, reply) => {
    const apresentadoraId = String(request.params?.id ?? '')
    const mes = String(request.query?.mes ?? '')
    if (!z.string().uuid().safeParse(apresentadoraId).success) return reply.code(400).send({ error: 'id inválido' })
    if (!MES_RE.test(mes)) return reply.code(400).send({ error: 'mes deve ter o formato YYYY-MM' })
    return app.withTenant(request.user.tenant_id, (db) => buscarHistoricoLivesApresentadora(db, {
      tenantId: request.user.tenant_id,
      apresentadoraId,
      mes,
    }))
  })

  app.post('/v1/financeiro/adicionais-apresentadoras', { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const parsed = adicionalSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const entrada = parsed.data
    const competencia = competenciaDoMes(entrada.mes)
    let valor
    let dataReferencia = null
    if (entrada.tipo === 'fim_de_semana') {
      dataReferencia = entrada.data_referencia
      if (!dataReferencia || !dataEhFimDeSemana(dataReferencia) || !dataReferencia.startsWith(`${entrada.mes}-`)) {
        return reply.code(400).send({ error: 'A diária exige um sábado ou domingo válido dentro do mês informado.' })
      }
      valor = 100
    } else {
      const cents = dinheiroEmCentavos(entrada.valor)
      if (cents == null || cents <= 0) return reply.code(400).send({ error: 'Valor da bonificação deve ser positivo e ter no máximo duas casas decimais.' })
      valor = cents / 100
      if (entrada.data_referencia) {
        if (!dataEhValida(entrada.data_referencia) || !entrada.data_referencia.startsWith(`${entrada.mes}-`)) {
          return reply.code(400).send({ error: 'A data de referência deve pertencer ao mês informado.' })
        }
        dataReferencia = entrada.data_referencia
      }
    }
    try {
      const criado = await app.withTenant(request.user.tenant_id, async (db) => {
        const result = await db.query(`
          INSERT INTO apresentadora_remuneracao_adicionais
            (tenant_id, apresentadora_id, competencia, tipo, descricao, data_referencia, valor, criado_por, client_request_id)
          SELECT $1::uuid, a.id, $3::date, $4, $5, $6::date, $7::numeric, $8::uuid, $9::uuid
          FROM apresentadoras a
          WHERE a.id = $2::uuid AND a.tenant_id = $1::uuid
          ON CONFLICT (tenant_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
          RETURNING id, apresentadora_id, tipo, descricao, data_referencia::text AS data_referencia, valor, true AS criado
        `, [request.user.tenant_id, entrada.apresentadora_id, competencia, entrada.tipo, entrada.descricao, dataReferencia, valor, request.user.sub, entrada.request_id ?? null])
        if (result.rows[0]) return result.rows[0]
        if (!entrada.request_id) return null
        const existente = await db.query(`
          SELECT id, apresentadora_id, competencia::text AS competencia, tipo, descricao, data_referencia::text AS data_referencia, valor,
                 cancelado_em IS NOT NULL AS cancelado, false AS criado
          FROM apresentadora_remuneracao_adicionais
          WHERE tenant_id = $1::uuid AND client_request_id = $2::uuid
          LIMIT 1
        `, [request.user.tenant_id, entrada.request_id])
        const row = existente.rows[0]
        if (!row) return null
        const mesmoPedido = row.apresentadora_id === entrada.apresentadora_id
          && row.competencia === competencia
          && row.tipo === entrada.tipo
          && row.descricao === entrada.descricao
          && row.data_referencia === dataReferencia
          && Number(row.valor) === valor
        return mesmoPedido && !row.cancelado ? row : { conflito_idempotencia: true }
      })
      if (criado?.conflito_idempotencia) return reply.code(409).send({ error: 'request_id já foi usado para outro adicional.' })
      if (!criado) return reply.code(404).send({ error: 'Apresentadora não encontrada nesta unidade.' })
      if (criado.criado) app.audit?.log?.(request, {
        action: 'financeiro.adicional_apresentadora_create', entity_type: 'apresentadora_remuneracao_adicional', entity_id: criado.id,
        metadata: { apresentadora_id: criado.apresentadora_id, mes: entrada.mes, tipo: criado.tipo, descricao: criado.descricao, valor: Number(criado.valor), data_referencia: criado.data_referencia },
      })?.catch((err) => app.log.error({ err }, 'audit log failed'))
      return reply.code(criado.criado ? 201 : 200).send({ ...criado, criado: undefined, valor: Number(criado.valor) })
    } catch (err) {
      const message = erroBanco(err)
      if (message) return reply.code(409).send({ error: message })
      throw err
    }
  })

  app.delete('/v1/financeiro/adicionais-apresentadoras/:id', { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const id = String(request.params?.id ?? '')
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: 'id inválido' })
    const apagado = await app.withTenant(request.user.tenant_id, async (db) => {
      const result = await db.query(`
        UPDATE apresentadora_remuneracao_adicionais
        SET cancelado_em = NOW(), cancelado_por = $3::uuid, atualizado_em = NOW()
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND cancelado_em IS NULL
        RETURNING id, apresentadora_id, competencia::text AS competencia, tipo, descricao, data_referencia::text AS data_referencia, valor
      `, [id, request.user.tenant_id, request.user.sub])
      return result.rows[0] ?? null
    })
    if (!apagado) return reply.code(404).send({ error: 'Adicional não encontrado.' })
    app.audit?.log?.(request, {
      action: 'financeiro.adicional_apresentadora_cancel', entity_type: 'apresentadora_remuneracao_adicional', entity_id: apagado.id,
      metadata: { apresentadora_id: apagado.apresentadora_id, mes: String(apagado.competencia).slice(0, 7), tipo: apagado.tipo, descricao: apagado.descricao, valor: Number(apagado.valor), data_referencia: apagado.data_referencia },
    })?.catch((err) => app.log.error({ err }, 'audit log failed'))
    return { ok: true }
  })
}
