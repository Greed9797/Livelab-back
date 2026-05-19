import { z } from 'zod'
import { READ_APRESENTADORAS, WRITE_APRESENTADORAS } from '../config/role_groups.js'

const createSchema = z.object({
  nome:            z.string().min(1),
  telefone:        z.string().optional(),
  cargo:           z.string().optional(),
  email:           z.string().email().optional(),
  cpf_cnpj:        z.string().optional(),
  cidade:          z.string().optional(),
  fixo:            z.number().min(0).default(0),
  comissao_pct:    z.number().min(0).max(100).default(0),
  meta_diaria_gmv: z.number().min(0).default(0),
  valor_fixo_mensal: z.number().min(0).default(0),
  observacoes:     z.string().optional(),
  link_contrato:   z.string().optional(),
  data_aniversario: z.string().optional(),
  data_inicio:     z.string().optional(),
  data_fim:        z.string().optional(),
})

const updateSchema = createSchema.partial().extend({
  ativo: z.boolean().optional(),
})

const COLS = `id, nome, telefone, cargo, email, cpf_cnpj, cidade, ativo, fixo, comissao_pct, meta_diaria_gmv, valor_fixo_mensal, observacoes, link_contrato, data_aniversario, data_inicio, data_fim, criado_em`

export async function apresentadorasRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_APRESENTADORAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_APRESENTADORAS)]

  // GET /v1/apresentadoras
  app.get('/v1/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS} FROM apresentadoras a
         WHERE a.tenant_id = $1::uuid
         ORDER BY a.ativo DESC, a.nome ASC`,
        [tenant_id]
      )
      return result.rows
    })
  })

  // GET /v1/apresentadoras/:id
  app.get('/v1/apresentadoras/:id', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS} FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return result.rows[0]
    })
  })

  // POST /v1/apresentadoras
  app.post('/v1/apresentadoras', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `INSERT INTO apresentadoras (tenant_id, nome, telefone, cargo, email, cpf_cnpj, cidade, fixo, comissao_pct, meta_diaria_gmv, valor_fixo_mensal, observacoes, link_contrato, data_aniversario, data_inicio, data_fim)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING ${COLS}`,
        [tenant_id, d.nome, d.telefone ?? null, d.cargo ?? null, d.email ?? null,
         d.cpf_cnpj ?? null, d.cidade ?? null, d.fixo, d.comissao_pct, d.meta_diaria_gmv, d.valor_fixo_mensal,
         d.observacoes ?? null, d.link_contrato ?? null, d.data_aniversario ?? null, d.data_inicio ?? null, d.data_fim ?? null]
      )
      app.audit?.log?.(request, { action: 'apresentadora.create', entity_type: 'apresentadora', entity_id: result.rows[0].id, metadata: { nome: d.nome, cargo: d.cargo ?? null, fixo: d.fixo, comissao_pct: d.comissao_pct } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return reply.code(201).send(result.rows[0])
    })
  })

  // PATCH /v1/apresentadoras/:id
  app.patch('/v1/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(', ')
    const values = [request.params.id, tenant_id, ...fields.map((f) => updates[f])]

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE apresentadoras SET ${setClauses}
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING ${COLS}`,
        values
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      app.audit?.log?.(request, { action: 'apresentadora.update', entity_type: 'apresentadora', entity_id: request.params.id, metadata: { changed_fields: fields } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return result.rows[0]
    })
  })

  // DELETE /v1/apresentadoras/:id — desativa (soft delete)
  app.delete('/v1/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE apresentadoras SET ativo = false
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING id`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      app.audit?.log?.(request, { action: 'apresentadora.delete', entity_type: 'apresentadora', entity_id: request.params.id, metadata: { soft_delete: true } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return reply.code(204).send()
    })
  })

  // GET /v1/apresentadoras/:id/faixas
  app.get('/v1/apresentadoras/:id/faixas', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const ap = await db.query('SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
      if (!ap.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      const result = await db.query(
        `SELECT id, gmv_min, gmv_max, pct_comissao, vigente_desde, criado_em
         FROM apresentadora_faixas_comissao
         WHERE apresentadora_id = $1 AND tenant_id = $2::uuid
         ORDER BY gmv_min ASC`,
        [request.params.id, tenant_id],
      )
      return result.rows
    })
  })

  // POST /v1/apresentadoras/:id/faixas
  app.post('/v1/apresentadoras/:id/faixas', { preHandler: writeAccess }, async (request, reply) => {
    const schema = z.object({
      gmv_min: z.number().min(0).default(0),
      gmv_max: z.number().positive().nullable().optional(),
      pct_comissao: z.number().min(0).max(100),
      vigente_desde: z.string().optional(),
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const ap = await db.query('SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
      if (!ap.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      const result = await db.query(
        `INSERT INTO apresentadora_faixas_comissao (tenant_id, apresentadora_id, gmv_min, gmv_max, pct_comissao, vigente_desde)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenant_id, request.params.id, d.gmv_min, d.gmv_max ?? null, d.pct_comissao, d.vigente_desde ?? new Date().toISOString().slice(0, 10)],
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // DELETE /v1/apresentadoras/:id/faixas/:faixaId
  app.delete('/v1/apresentadoras/:id/faixas/:faixaId', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM apresentadora_faixas_comissao WHERE id = $1 AND apresentadora_id = $2 AND tenant_id = $3::uuid RETURNING id`,
        [request.params.faixaId, request.params.id, tenant_id],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Faixa não encontrada' })
      return reply.code(204).send()
    })
  })

  // GET /v1/ranking/apresentadoras?mes=YYYY-MM
  app.get('/v1/ranking/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const mesStr = request.query.mes
    const mesInicio = (mesStr && /^\d{4}-\d{2}$/.test(mesStr))
      ? `${mesStr}-01`
      : (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01` })()
    const [ano, mes] = mesInicio.split('-')
    const mesFim = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10)

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
           a.id,
           a.nome,
           a.valor_fixo_mensal,
           COALESCE(SUM(va.gmv), 0) AS gmv_total,
           COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_variavel,
           GREATEST(a.valor_fixo_mensal, COALESCE(SUM(va.comissao_apresentadora), 0)) AS ganho_total,
           COUNT(DISTINCT CASE WHEN va.origem = 'live' THEN va.origem_id END)::int AS total_lives,
           COALESCE(m.gmv_meta, 0) AS gmv_meta,
           CASE WHEN COALESCE(m.gmv_meta, 0) > 0
                THEN ROUND(COALESCE(SUM(va.gmv), 0) / m.gmv_meta * 100, 1)
                ELSE NULL END AS pct_meta,
           ROW_NUMBER() OVER (ORDER BY GREATEST(a.valor_fixo_mensal, COALESCE(SUM(va.comissao_apresentadora), 0)) DESC) AS posicao
         FROM apresentadoras a
         LEFT JOIN vendas_atribuidas va
           ON va.apresentadora_id = a.id
          AND va.tenant_id = $1::uuid
          AND va.data >= $2::date
          AND va.data <= $3::date
         LEFT JOIN metas_apresentadora m
           ON m.apresentadora_id = a.id AND m.mes_referencia = $2::date
         WHERE a.tenant_id = $1::uuid AND a.ativo = true
         GROUP BY a.id, a.nome, a.valor_fixo_mensal, m.gmv_meta
         ORDER BY ganho_total DESC`,
        [tenant_id, mesInicio, mesFim],
      )
      return result.rows
    })
  })
}
