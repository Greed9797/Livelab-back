import { z } from 'zod'

const WRITE_METAS = ['franqueador_master', 'franqueado', 'gerente', 'operacional']
const READ_METAS = ['franqueador_master', 'franqueado', 'gerente', 'operacional',
  'financeiro', 'financeiro_readonly', 'auditor', 'produtor_live', 'marketing', 'comercial_readonly']

function parseMes(mesStr) {
  if (!mesStr || !/^\d{4}-\d{2}$/.test(mesStr)) {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  }
  return `${mesStr}-01`
}

const metaApSchema = z.object({
  gmv_meta: z.number().min(0),
})

const metaSupSchema = z.object({
  gmv_meta_total: z.number().min(0),
  calculado_automaticamente: z.boolean().optional().default(true),
})

export async function metasRoutes(app) {
  const readAccess  = [app.authenticate, app.requirePapel(READ_METAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_METAS)]

  // GET /v1/metas/apresentadoras?mes=YYYY-MM
  // Retorna todas as apresentadoras ativas + suas metas + GMV realizado no mês
  app.get('/v1/metas/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const mesInicio = parseMes(request.query.mes)
    const [ano, mes] = mesInicio.split('-')
    const mesFim = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10)

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
           a.id,
           a.nome,
           a.valor_fixo_mensal,
           COALESCE(m.gmv_meta, 0) AS gmv_meta,
           COALESCE(m.id, NULL) AS meta_id,
           COALESCE(SUM(va.gmv), 0) AS gmv_realizado,
           COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_variavel,
           GREATEST(a.valor_fixo_mensal, COALESCE(SUM(va.comissao_apresentadora), 0)) AS ganho_estimado,
           CASE WHEN COALESCE(m.gmv_meta, 0) > 0
                THEN ROUND(COALESCE(SUM(va.gmv), 0) / m.gmv_meta * 100, 1)
                ELSE 0 END AS pct_meta_atingida
         FROM apresentadoras a
         LEFT JOIN metas_apresentadora m
           ON m.apresentadora_id = a.id AND m.mes_referencia = $2::date
         LEFT JOIN vendas_atribuidas va
           ON va.apresentadora_id = a.id
          AND va.tenant_id = $1::uuid
          AND va.data >= $2::date
          AND va.data <= $3::date
         WHERE a.tenant_id = $1::uuid AND a.ativo = true
         GROUP BY a.id, a.nome, a.valor_fixo_mensal, m.gmv_meta, m.id
         ORDER BY a.nome ASC`,
        [tenant_id, mesInicio, mesFim],
      )
      return result.rows
    })
  })

  // PUT /v1/metas/apresentadoras/:id?mes=YYYY-MM — upsert meta de uma apresentadora
  app.put('/v1/metas/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = metaApSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub } = request.user
    const mesInicio = parseMes(request.query.mes)
    const { gmv_meta } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      const ap = await db.query(
        'SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid AND ativo = true',
        [request.params.id, tenant_id],
      )
      if (!ap.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

      const result = await db.query(
        `INSERT INTO metas_apresentadora (tenant_id, apresentadora_id, mes_referencia, gmv_meta, criado_por)
         VALUES ($1, $2, $3::date, $4, $5)
         ON CONFLICT (apresentadora_id, mes_referencia)
         DO UPDATE SET gmv_meta = EXCLUDED.gmv_meta, atualizado_em = NOW()
         RETURNING *`,
        [tenant_id, request.params.id, mesInicio, gmv_meta, sub],
      )
      return result.rows[0]
    })
  })

  // DELETE /v1/metas/apresentadoras/:id?mes=YYYY-MM
  app.delete('/v1/metas/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const mesInicio = parseMes(request.query.mes)

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM metas_apresentadora
         WHERE apresentadora_id = $1 AND tenant_id = $2::uuid AND mes_referencia = $3::date
         RETURNING id`,
        [request.params.id, tenant_id, mesInicio],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Meta não encontrada' })
      return reply.code(204).send()
    })
  })

  // GET /v1/metas/supervisor?mes=YYYY-MM
  app.get('/v1/metas/supervisor', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const mesInicio = parseMes(request.query.mes)
    const [ano, mes] = mesInicio.split('-')
    const mesFim = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10)

    return app.withTenant(tenant_id, async (db) => {
      const [supervisor, somaAps, gmvRealizado] = await Promise.all([
        db.query(
          `SELECT * FROM metas_supervisor WHERE tenant_id = $1::uuid AND mes_referencia = $2::date LIMIT 1`,
          [tenant_id, mesInicio],
        ),
        db.query(
          `SELECT COALESCE(SUM(gmv_meta), 0) AS soma_metas
           FROM metas_apresentadora WHERE tenant_id = $1::uuid AND mes_referencia = $2::date`,
          [tenant_id, mesInicio],
        ),
        db.query(
          `SELECT COALESCE(SUM(gmv), 0) AS gmv_total, COALESCE(SUM(comissao_apresentadora), 0) AS comissao_total
           FROM vendas_atribuidas WHERE tenant_id = $1::uuid AND data >= $2::date AND data <= $3::date`,
          [tenant_id, mesInicio, mesFim],
        ),
      ])

      const meta_automatica = Number(somaAps.rows[0]?.soma_metas ?? 0)
      const meta_manual = supervisor.rows[0]
      const gmv_meta_total = meta_manual && !meta_manual.calculado_automaticamente
        ? Number(meta_manual.gmv_meta_total)
        : meta_automatica

      return {
        mes_referencia: mesInicio,
        gmv_meta_total,
        calculado_automaticamente: !meta_manual || meta_manual.calculado_automaticamente,
        meta_automatica_soma_aps: meta_automatica,
        gmv_realizado: Number(gmvRealizado.rows[0]?.gmv_total ?? 0),
        comissao_total_apresentadoras: Number(gmvRealizado.rows[0]?.comissao_total ?? 0),
        supervisor_id: meta_manual?.supervisor_id ?? null,
      }
    })
  })

  // PUT /v1/metas/supervisor?mes=YYYY-MM
  app.put('/v1/metas/supervisor', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = metaSupSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub } = request.user
    const mesInicio = parseMes(request.query.mes)
    const { gmv_meta_total, calculado_automaticamente } = parsed.data

    const result = await app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `INSERT INTO metas_supervisor (tenant_id, mes_referencia, gmv_meta_total, calculado_automaticamente, supervisor_id)
         VALUES ($1, $2::date, $3, $4, $5)
         ON CONFLICT (tenant_id, mes_referencia)
         DO UPDATE SET gmv_meta_total = EXCLUDED.gmv_meta_total,
                       calculado_automaticamente = EXCLUDED.calculado_automaticamente,
                       atualizado_em = NOW()
         RETURNING *`,
        [tenant_id, mesInicio, gmv_meta_total, calculado_automaticamente, sub],
      )
      return r.rows[0]
    })

    await app.audit.log(request, {
      action: 'metas.supervisor.update',
      entity_type: 'tenant',
      entity_id: tenant_id,
      metadata: { mes: request.query.mes, gmv_meta_total },
    })

    return result
  })
}
