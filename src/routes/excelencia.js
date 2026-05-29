export async function excelenciaRoutes(app) {
  // GET /v1/excelencia/metricas
  app.get('/v1/excelencia/metricas', { onRequest: [app.authenticate, app.requirePapel(['franqueado', 'gerente'])] }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const base = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'ativo')     AS ativos,
          COUNT(*) FILTER (WHERE status = 'cancelado') AS cancelados,
          COUNT(*) FILTER (WHERE status IN ('ativo', 'cancelado')) AS total_fechados
        FROM contratos
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
      `)

      const fatSeries = await db.query(`
        SELECT date_trunc('month', encerrado_em) AS mes,
	               SUM(COALESCE(ads_gmv, manual_gmv, fat_gerado, 0)) AS total
        FROM lives
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND encerrado_em IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC LIMIT 2
      `)

      const b = base.rows[0]
      const [mesAtual, mesAnterior] = fatSeries.rows

      const ativos       = Number(b.ativos)
      const cancelados   = Number(b.cancelados)
      const total        = Number(b.total_fechados)
      const taxaRetencao = total > 0 ? Math.round((ativos / total) * 100) : 0

      const fatMes      = Number(mesAtual?.total ?? 0)
      const fatMesAnt   = Number(mesAnterior?.total ?? 0)
      const crescimento = fatMesAnt > 0
        ? Math.round(((fatMes - fatMesAnt) / fatMesAnt) * 100)
        : 0

      // Score de excelência: retenção 40% + crescimento 30% + base ativa 30%
      const scoreRetencao    = Math.min(taxaRetencao, 100) * 0.4
      const scoreCrescimento = Math.min(Math.max(crescimento + 50, 0), 100) * 0.3
      const scoreBase        = Math.min(ativos * 2, 100) * 0.3
      const score            = Math.round(scoreRetencao + scoreCrescimento + scoreBase)

      return {
        ativos,
        cancelados,
        taxa_retencao: taxaRetencao,
        fat_mes_atual:    fatMes,
        fat_mes_anterior: fatMesAnt,
        crescimento_pct:  crescimento,
        score,
      }
    })
  })
}
