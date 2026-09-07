// Routes: meta mensal da unidade — fonte canônica da meta da franquia.
// Table: meta_unidade (migration 100). A meta é definida MENSAL e a diária
// é derivada automaticamente (meta_gmv ÷ dias úteis seg–sex do mês).
// Colunas m1..m4 (faixas) são legado sem consumidor: não expostas nem gravadas.
// Audit: metas.unidade.update
import { countWeekdaysInMonth } from '../lib/dias_uteis.js'
import { saoPauloDateInput } from '../lib/timezone.js'

const ANO_MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function round2(n) {
  return Math.round(n * 100) / 100
}

function withDerivada(anoMes, metas = {}) {
  const [y, m] = anoMes.split('-').map(Number)
  const diasUteis = countWeekdaysInMonth(y, m)
  const meta = Number(metas.meta_gmv ?? 0)
  return {
    ano_mes: anoMes,
    meta_gmv: round2(meta),
    // Metas novas são opcionais. Null significa que a unidade ainda não
    // definiu aquela régua para a competência — zero é uma meta explícita.
    meta_horas_live: metas.meta_horas_live == null ? null : round2(metas.meta_horas_live),
    meta_gmv_hora: metas.meta_gmv_hora == null ? null : round2(metas.meta_gmv_hora),
    dias_uteis: diasUteis,
    meta_diaria: meta > 0 && diasUteis > 0 ? round2(meta / diasUteis) : null,
  }
}

function hasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key)
}

function isNonNegativeDecimal(value) {
  // Não coagir null, boolean, arrays ou texto em branco: Number(null) = 0 e
  // transformaria uma limpeza acidental em meta zero. NUMERIC(15,2) também não
  // deve arredondar silenciosamente uma meta informada com mais de dois centavos.
  if (typeof value === 'number') {
    return Number.isFinite(value)
      && value >= 0
      && value <= 9999999999999.99
      // A multiplicação por 100 também introduz ruído para valores válidos
      // como 9876543.21. A representação decimal canônica do próprio número
      // preserva a precisão que veio no JSON sem aceitar terceira casa.
      && /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(String(value))
  }
  if (typeof value !== 'string') return false
  return /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(value)
}

export async function metaUnidadeRoutes(app) {
  app.get('/v1/meta-unidade', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const mes = request.query.ano_mes || saoPauloDateInput(new Date()).slice(0, 7)
    if (!ANO_MES_RE.test(mes)) {
      return reply.code(400).send({ error: 'ano_mes deve ter o formato YYYY-MM.' })
    }
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `SELECT meta_gmv, meta_horas_live, meta_gmv_hora
         FROM meta_unidade WHERE tenant_id = $1 AND ano_mes = $2`,
        [tenant_id, mes]
      )
      return withDerivada(mes, r.rows[0])
    })
  })

  app.put('/v1/meta-unidade', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const body = request.body ?? {}
    const { ano_mes } = body
    const mes = ano_mes || saoPauloDateInput(new Date()).slice(0, 7)
    if (!ANO_MES_RE.test(mes)) {
      return reply.code(400).send({ error: 'ano_mes deve ter o formato YYYY-MM.' })
    }
    const hasMetaGmv = hasOwn(body, 'meta_gmv')
    const hasMetaHoras = hasOwn(body, 'meta_horas_live')
    const hasMetaGmvHora = hasOwn(body, 'meta_gmv_hora')
    if (!hasMetaGmv && !hasMetaHoras && !hasMetaGmvHora) {
      return reply.code(400).send({ error: 'Informe ao menos uma meta para atualizar.' })
    }
    if (hasMetaGmv && !isNonNegativeDecimal(body.meta_gmv)) {
      return reply.code(400).send({ error: 'meta_gmv deve ser numérico >= 0.' })
    }
    // Diferente de meta_gmv (campo legado NOT NULL), as duas novas metas podem
    // receber null explicitamente para limpar somente aquela competência.
    if (hasMetaHoras && body.meta_horas_live != null && !isNonNegativeDecimal(body.meta_horas_live)) {
      return reply.code(400).send({ error: 'meta_horas_live deve ser numérico >= 0 ou null.' })
    }
    if (hasMetaGmvHora && body.meta_gmv_hora != null && !isNonNegativeDecimal(body.meta_gmv_hora)) {
      return reply.code(400).send({ error: 'meta_gmv_hora deve ser numérico >= 0 ou null.' })
    }

    const result = await app.withTenant(tenant_id, async (db) => {
      const r = await db.query(`
        INSERT INTO meta_unidade (tenant_id, ano_mes, meta_gmv, meta_horas_live, meta_gmv_hora)
        VALUES ($1, $2, COALESCE($3, 0), $4, $5)
        ON CONFLICT (tenant_id, ano_mes) DO UPDATE SET
          meta_gmv = CASE WHEN $6::boolean THEN EXCLUDED.meta_gmv ELSE meta_unidade.meta_gmv END,
          meta_horas_live = CASE WHEN $7::boolean THEN EXCLUDED.meta_horas_live ELSE meta_unidade.meta_horas_live END,
          meta_gmv_hora = CASE WHEN $8::boolean THEN EXCLUDED.meta_gmv_hora ELSE meta_unidade.meta_gmv_hora END,
          atualizado_em = NOW()
        RETURNING ano_mes, meta_gmv, meta_horas_live, meta_gmv_hora
      `, [
        tenant_id,
        mes,
        hasMetaGmv ? Number(body.meta_gmv) : null,
        hasMetaHoras && body.meta_horas_live != null ? Number(body.meta_horas_live) : null,
        hasMetaGmvHora && body.meta_gmv_hora != null ? Number(body.meta_gmv_hora) : null,
        hasMetaGmv,
        hasMetaHoras,
        hasMetaGmvHora,
      ])
      return r.rows[0]
    })

    await app.audit.log(request, {
      action: 'metas.unidade.update',
      entity_type: 'tenant',
      entity_id: tenant_id,
      metadata: {
        ano_mes: mes,
        ...(hasMetaGmv ? { meta_gmv: Number(body.meta_gmv) } : {}),
        ...(hasMetaHoras ? { meta_horas_live: body.meta_horas_live == null ? null : Number(body.meta_horas_live) } : {}),
        ...(hasMetaGmvHora ? { meta_gmv_hora: body.meta_gmv_hora == null ? null : Number(body.meta_gmv_hora) } : {}),
      },
    })

    return withDerivada(result.ano_mes, result)
  })
}
