// Routes: metas apresentadoras + supervisor (GMV mensal)
// Tables: metas_apresentadora, metas_supervisor (migration 090)
// Audit: metas.apresentadora.update, metas.supervisor.update

function mesReferenciaFromMes(mes) {
  // mes = 'YYYY-MM' → DATE '20YY-MM-01'
  return mes ? `${mes}-01` : `${new Date().toISOString().slice(0, 7)}-01`
}

export async function metasRoutes(app) {
  // ── GET /v1/metas/apresentadoras?mes=YYYY-MM ──────────────────────────────
  // Lista todas apresentadoras ativas com meta_gmv do mês e gmv_realizado
  app.get('/v1/metas/apresentadoras', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request) => {
    const { tenant_id } = request.user
    const mes = request.query.mes || new Date().toISOString().slice(0, 7)
    const mesRef = mesReferenciaFromMes(mes)

    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(`
        SELECT
          a.id                          AS apresentadora_id,
          a.nome,
          COALESCE(ma.gmv_meta, 0)      AS meta_gmv,
          COALESCE(SUM(va.gmv), 0)      AS gmv_realizado
        FROM apresentadoras a
        LEFT JOIN metas_apresentadora ma
          ON ma.apresentadora_id = a.id
         AND ma.tenant_id       = a.tenant_id
         AND ma.mes_referencia  = $2
        LEFT JOIN vendas_atribuidas va
          ON va.apresentadora_id = a.id
         AND va.tenant_id        = a.tenant_id
         AND to_char(va.data, 'YYYY-MM') = $3
        WHERE a.tenant_id = $1
          AND a.ativo = true
        GROUP BY a.id, a.nome, ma.gmv_meta
        ORDER BY a.nome
      `, [tenant_id, mesRef, mes])

      return r.rows
    })
  })

  // ── PUT /v1/metas/apresentadoras/:id?mes=YYYY-MM ──────────────────────────
  // Upsert meta de GMV de uma apresentadora para o mês
  app.put('/v1/metas/apresentadoras/:id', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id, sub: user_id } = request.user
    const { id } = request.params
    const mes = request.query.mes || new Date().toISOString().slice(0, 7)
    const mesRef = mesReferenciaFromMes(mes)
    const { gmv_meta } = request.body ?? {}

    if (gmv_meta == null || isNaN(Number(gmv_meta))) {
      return reply.code(400).send({ error: 'gmv_meta é obrigatório e deve ser numérico.' })
    }

    const result = await app.withTenant(tenant_id, async (db) => {
      const r = await db.query(`
        INSERT INTO metas_apresentadora
          (tenant_id, apresentadora_id, mes_referencia, gmv_meta, criado_por)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, apresentadora_id, mes_referencia) DO UPDATE SET
          gmv_meta     = EXCLUDED.gmv_meta,
          atualizado_em = NOW()
        RETURNING *
      `, [tenant_id, id, mesRef, Number(gmv_meta), user_id])

      return r.rows[0]
    })

    await app.audit.log(request, {
      action: 'metas.apresentadora.update',
      entity_type: 'apresentadora',
      entity_id: id,
      metadata: { mes, gmv_meta: Number(gmv_meta) },
    })

    return result
  })

  // ── GET /v1/metas/supervisor?mes=YYYY-MM ─────────────────────────────────
  // Retorna meta consolidada do supervisor para o tenant no mês
  app.get('/v1/metas/supervisor', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request) => {
    const { tenant_id } = request.user
    const mes = request.query.mes || new Date().toISOString().slice(0, 7)
    const mesRef = mesReferenciaFromMes(mes)

    return app.withTenant(tenant_id, async (db) => {
      const metaRow = await db.query(`
        SELECT gmv_meta_total, calculado_automaticamente
        FROM metas_supervisor
        WHERE tenant_id = $1 AND mes_referencia = $2
      `, [tenant_id, mesRef])

      const gmvRow = await db.query(`
        SELECT COALESCE(SUM(gmv), 0) AS gmv_realizado
        FROM vendas_atribuidas
        WHERE tenant_id = $1
          AND to_char(data, 'YYYY-MM') = $2
      `, [tenant_id, mes])

      return {
        meta_gmv: Number(metaRow.rows[0]?.gmv_meta_total ?? 0),
        gmv_realizado: Number(gmvRow.rows[0]?.gmv_realizado ?? 0),
        calculado_automaticamente: metaRow.rows[0]?.calculado_automaticamente ?? true,
      }
    })
  })

  // ── PUT /v1/metas/supervisor?mes=YYYY-MM ──────────────────────────────────
  // Upsert meta consolidada do supervisor para o tenant no mês
  app.put('/v1/metas/supervisor', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id, sub: user_id } = request.user
    const mes = request.query.mes || new Date().toISOString().slice(0, 7)
    const mesRef = mesReferenciaFromMes(mes)
    const { gmv_meta_total } = request.body ?? {}

    if (gmv_meta_total == null || isNaN(Number(gmv_meta_total))) {
      return reply.code(400).send({ error: 'gmv_meta_total é obrigatório e deve ser numérico.' })
    }

    const result = await app.withTenant(tenant_id, async (db) => {
      const r = await db.query(`
        INSERT INTO metas_supervisor
          (tenant_id, mes_referencia, gmv_meta_total, calculado_automaticamente, supervisor_id)
        VALUES ($1, $2, $3, false, $4)
        ON CONFLICT (tenant_id, mes_referencia) DO UPDATE SET
          gmv_meta_total            = EXCLUDED.gmv_meta_total,
          calculado_automaticamente = false,
          supervisor_id             = EXCLUDED.supervisor_id,
          atualizado_em             = NOW()
        RETURNING *
      `, [tenant_id, mesRef, Number(gmv_meta_total), user_id])

      return r.rows[0]
    })

    await app.audit.log(request, {
      action: 'metas.supervisor.update',
      entity_type: 'tenant',
      entity_id: tenant_id,
      metadata: { mes, gmv_meta_total: Number(gmv_meta_total) },
    })

    return result
  })
}
