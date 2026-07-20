// Routes: meta mensal da unidade — fonte canônica da meta da franquia.
// Table: meta_unidade (migration 100). A meta é definida MENSAL e a diária
// é derivada automaticamente (meta_gmv ÷ dias úteis seg–sex do mês).
// Colunas m1..m4 (faixas) são legado sem consumidor: não expostas nem gravadas.
// Audit: metas.unidade.update
import { countWeekdaysInMonth } from '../lib/dias_uteis.js'

const ANO_MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function round2(n) {
  return Math.round(n * 100) / 100
}

function withDerivada(anoMes, metaGmv) {
  const [y, m] = anoMes.split('-').map(Number)
  const diasUteis = countWeekdaysInMonth(y, m)
  const meta = Number(metaGmv)
  return {
    ano_mes: anoMes,
    meta_gmv: round2(meta),
    dias_uteis: diasUteis,
    meta_diaria: meta > 0 && diasUteis > 0 ? round2(meta / diasUteis) : null,
  }
}

export async function metaUnidadeRoutes(app) {
  app.get('/v1/meta-unidade', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const mes = request.query.ano_mes || new Date().toISOString().slice(0, 7)
    if (!ANO_MES_RE.test(mes)) {
      return reply.code(400).send({ error: 'ano_mes deve ter o formato YYYY-MM.' })
    }
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `SELECT meta_gmv FROM meta_unidade WHERE tenant_id = $1 AND ano_mes = $2`,
        [tenant_id, mes]
      )
      return withDerivada(mes, r.rows[0]?.meta_gmv ?? 0)
    })
  })

  app.put('/v1/meta-unidade', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const { ano_mes, meta_gmv } = request.body ?? {}
    const mes = ano_mes || new Date().toISOString().slice(0, 7)
    if (!ANO_MES_RE.test(mes)) {
      return reply.code(400).send({ error: 'ano_mes deve ter o formato YYYY-MM.' })
    }
    if (meta_gmv == null || isNaN(Number(meta_gmv)) || Number(meta_gmv) < 0) {
      return reply.code(400).send({ error: 'meta_gmv é obrigatório e deve ser numérico >= 0.' })
    }

    const result = await app.withTenant(tenant_id, async (db) => {
      const r = await db.query(`
        INSERT INTO meta_unidade (tenant_id, ano_mes, meta_gmv)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, ano_mes) DO UPDATE SET
          meta_gmv = EXCLUDED.meta_gmv,
          atualizado_em = NOW()
        RETURNING ano_mes, meta_gmv
      `, [tenant_id, mes, Number(meta_gmv)])
      return r.rows[0]
    })

    await app.audit.log(request, {
      action: 'metas.unidade.update',
      entity_type: 'tenant',
      entity_id: tenant_id,
      metadata: { ano_mes: mes, meta_gmv: Number(meta_gmv) },
    })

    return withDerivada(result.ano_mes, result.meta_gmv)
  })
}
