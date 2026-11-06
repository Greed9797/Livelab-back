import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_CONFIGURACOES } from '../config/role_groups.js'
import { feriadosDoAno } from '../lib/calendario-blumenau.js'
import { dataEhValida } from '../services/remuneracao-apresentadoras.js'
import { recalcularVendasAtribuidasApresentadora } from './vendas_atribuidas.js'

const corpoSchema = z.object({
  nome: z.string().trim().min(1, 'Nome é obrigatório').max(120),
  ativo: z.boolean().default(true),
}).strict()

// A comissão de 2% é gravada na venda. Mudar o feriado recalcula as vendas
// ainda pendentes do mês; as já aprovadas/fechadas não mudam.
async function recalcularMes(db, tenantId, data) {
  const mes = data.slice(0, 7)
  const { rows } = await db.query(
    `SELECT DISTINCT apresentadora_id FROM vendas_atribuidas
      WHERE tenant_id = $1::uuid AND apresentadora_id IS NOT NULL
        AND data >= $2::date AND data < ($2::date + interval '1 month')`,
    [tenantId, `${mes}-01`],
  )
  for (const row of rows) {
    await recalcularVendasAtribuidasApresentadora(db, { tenantId, apresentadoraId: row.apresentadora_id, mesReferencia: mes })
  }
}

export async function feriadosRoutes(app) {
  // Lista do ano: calendário embutido + ajustes da unidade.
  app.get('/v1/feriados', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request, reply) => {
    const ano = Number(request.query?.ano ?? new Date().getFullYear())
    if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return reply.code(400).send({ error: 'ano inválido' })
    const { rows } = await app.withTenant(request.user.tenant_id, (db) => db.query(
      `SELECT to_char(data, 'YYYY-MM-DD') AS data, nome, ativo FROM feriados
        WHERE tenant_id = $1::uuid AND data >= $2::date AND data <= $3::date`,
      [request.user.tenant_id, `${ano}-01-01`, `${ano}-12-31`],
    ))
    const porData = new Map(Object.entries(feriadosDoAno(ano)).map(([data, nome]) => [data, { data, nome, ativo: true, origem: 'calendario', ajustado: false }]))
    for (const row of rows) {
      const base = porData.get(row.data)
      porData.set(row.data, { data: row.data, nome: row.nome, ativo: row.ativo, origem: base ? 'calendario' : 'unidade', ajustado: true })
    }
    return { ano, items: [...porData.values()].sort((a, b) => a.data.localeCompare(b.data)), pode_editar: WRITE_CONFIGURACOES.includes(request.user.papel) }
  })

  // Cria, renomeia ou desliga (ativo=false) o feriado daquela data.
  app.put('/v1/feriados/:data', { preHandler: app.requirePapel(WRITE_CONFIGURACOES) }, async (request, reply) => {
    const data = String(request.params?.data ?? '')
    if (!dataEhValida(data)) return reply.code(400).send({ error: 'data inválida (YYYY-MM-DD)' })
    const parsed = corpoSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const tenantId = request.user.tenant_id
    const salvo = await app.withTenant(tenantId, async (db) => {
      const result = await db.query(
        `INSERT INTO feriados (tenant_id, data, nome, ativo, atualizado_por)
         VALUES ($1::uuid, $2::date, $3, $4, $5::uuid)
         ON CONFLICT (tenant_id, data) DO UPDATE
           SET nome = EXCLUDED.nome, ativo = EXCLUDED.ativo, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()
         RETURNING to_char(data, 'YYYY-MM-DD') AS data, nome, ativo`,
        [tenantId, data, parsed.data.nome, parsed.data.ativo, request.user.sub],
      )
      await recalcularMes(db, tenantId, data)
      return result.rows[0]
    })
    app.audit?.log?.(request, { action: 'configuracoes.feriado_upsert', entity_type: 'feriado', entity_id: null, metadata: salvo })
      ?.catch((err) => app.log.error({ err }, 'audit log failed'))
    return salvo
  })

  // Remove o ajuste da unidade: a data volta ao calendário embutido.
  app.delete('/v1/feriados/:data', { preHandler: app.requirePapel(WRITE_CONFIGURACOES) }, async (request, reply) => {
    const data = String(request.params?.data ?? '')
    if (!dataEhValida(data)) return reply.code(400).send({ error: 'data inválida (YYYY-MM-DD)' })
    const tenantId = request.user.tenant_id
    const apagado = await app.withTenant(tenantId, async (db) => {
      const result = await db.query(
        `DELETE FROM feriados WHERE tenant_id = $1::uuid AND data = $2::date
         RETURNING to_char(data, 'YYYY-MM-DD') AS data, nome, ativo`,
        [tenantId, data],
      )
      if (result.rows[0]) await recalcularMes(db, tenantId, data)
      return result.rows[0] ?? null
    })
    if (!apagado) return reply.code(404).send({ error: 'Ajuste de feriado não encontrado.' })
    app.audit?.log?.(request, { action: 'configuracoes.feriado_delete', entity_type: 'feriado', entity_id: null, metadata: apagado })
      ?.catch((err) => app.log.error({ err }, 'audit log failed'))
    return { ok: true }
  })
}
