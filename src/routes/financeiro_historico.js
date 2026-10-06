import { READ_FINANCEIRO } from '../config/role_groups.js'
import { compararLiquidacoesLegado } from '../services/financeiro-liquidacoes-legacy-comparison.js'
import { lerLiquidacoesOrigem } from '../services/financeiro-liquidacoes-read.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORIGEM_TIPO = Object.freeze({
  marca_fixo: 'receita_titulo', marca_comissao: 'receita_titulo',
  avulsa: 'receita_avulsa', manual: 'custo', recorrente: 'custo', parcela: 'custo',
  apresentadora: 'apresentadora_pagamento', imposto: 'imposto',
})

export async function financeiroHistoricoRoutes(app) {
  app.get('/v1/financeiro/consulta/:origem/:id/historico', {
    preHandler: app.requirePapel(READ_FINANCEIRO),
  }, async (request, reply) => {
    const { origem, id } = request.params
    const origemTipo = Object.hasOwn(ORIGEM_TIPO, origem) ? ORIGEM_TIPO[origem] : null
    if (!origemTipo || !UUID.test(id)) return reply.code(400).send({ error: 'Origem ou ID inválido' })
    const tenantId = request.user?.tenant_id
    if (!tenantId) return reply.code(403).send({ error: 'Tenant obrigatório' })
    reply.header('Cache-Control', 'no-store')
    return app.withTenant(tenantId, async (db) => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        const [comparacao] = await compararLiquidacoesLegado(db, {
          tenantId, origemTipo, origemIds: [id],
        })
        if (!comparacao) {
          await db.query('COMMIT')
          return reply.code(404).send({ error: 'Obrigação não encontrada' })
        }
        if (comparacao.origem_categoria !== origem) {
          await db.query('COMMIT')
          return reply.code(404).send({ error: 'Obrigação não encontrada' })
        }
        const fatos = await lerLiquidacoesOrigem(db, {
          tenantId, origemTipo, origemId: id, listarDatas: true,
        })
        await db.query('COMMIT')
        return {
          origem, origem_id: id, origem_tipo: origemTipo,
          componente: comparacao.componente,
          estado_comparacao: comparacao.classificacao,
          valor_legado: comparacao.valor_legado,
          valor_canonico: comparacao.valor_canonico,
          natureza_incorreta: comparacao.natureza_incorreta,
          // Um valor legado sem fatos canônicos nunca vira histórico "sem pagamentos".
          historico_incompleto: comparacao.classificacao !== 'matching',
          ...fatos,
        }
      } catch (error) {
        try { await db.query('ROLLBACK') } catch (rollbackError) { app.log.error({ err: rollbackError }, 'financeiro historico rollback failed') }
        throw error
      }
    })
  })
}
