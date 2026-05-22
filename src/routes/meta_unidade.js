export async function metaUnidadeRoutes(app) {
  app.get('/v1/meta-unidade', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request) => {
    const { tenant_id } = request.user
    const { ano_mes } = request.query
    return app.withTenant(tenant_id, async (db) => {
      const mes = ano_mes || new Date().toISOString().slice(0, 7)
      const r = await db.query(
        `SELECT * FROM meta_unidade WHERE tenant_id = $1 AND ano_mes = $2`,
        [tenant_id, mes]
      )
      return r.rows[0] ?? { meta_gmv: 0, m1_teto: 600000, m1_pct: 0.25, m2_teto: 1200000, m2_pct: 0.35, m3_teto: 2000000, m3_pct: 0.65, m4_pct: 1.00 }
    })
  })

  app.put('/v1/meta-unidade', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request) => {
    const { tenant_id } = request.user
    const { ano_mes, meta_gmv, m1_teto, m1_pct, m2_teto, m2_pct, m3_teto, m3_pct, m4_pct } = request.body
    return app.withTenant(tenant_id, async (db) => {
      const mes = ano_mes || new Date().toISOString().slice(0, 7)
      const r = await db.query(`
        INSERT INTO meta_unidade (tenant_id, ano_mes, meta_gmv, m1_teto, m1_pct, m2_teto, m2_pct, m3_teto, m3_pct, m4_pct)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (tenant_id, ano_mes) DO UPDATE SET
          meta_gmv = EXCLUDED.meta_gmv,
          m1_teto = EXCLUDED.m1_teto, m1_pct = EXCLUDED.m1_pct,
          m2_teto = EXCLUDED.m2_teto, m2_pct = EXCLUDED.m2_pct,
          m3_teto = EXCLUDED.m3_teto, m3_pct = EXCLUDED.m3_pct,
          m4_pct = EXCLUDED.m4_pct,
          atualizado_em = NOW()
        RETURNING *
      `, [tenant_id, mes, meta_gmv ?? 0, m1_teto ?? 600000, m1_pct ?? 0.25, m2_teto ?? 1200000, m2_pct ?? 0.35, m3_teto ?? 2000000, m3_pct ?? 0.65, m4_pct ?? 1.00])
      return r.rows[0]
    })
  })
}
