import { z } from 'zod'

const custoSchema = z.object({
  descricao:   z.string().min(1),
  valor:       z.number().positive(),
  tipo:        z.enum(['aluguel','salario','energia','internet','outros']),
  competencia: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'Formato: YYYY-MM ou YYYY-MM-DD'),
})

const toNum = (v) => Number(v ?? 0)

export async function financeiroRoutes(app) {
  // GET /v1/financeiro/resumo?mes=&ano=
  app.get('/v1/financeiro/resumo', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request) => {
    const { tenant_id } = request.user
    const { mes, ano } = request.query
    const periodo = mes && ano
      ? `${ano}-${String(mes).padStart(2, '0')}-01`
      : new Date().toISOString().slice(0, 7) + '-01'

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(`
        WITH contratos_mes AS (
          SELECT
            COALESCE(SUM(c.valor_fixo), 0)                          AS fat_bruto_fixo,
            COALESCE(SUM(l.fat_gerado * c.comissao_pct / 100.0), 0) AS fat_bruto_comissao
          FROM contratos c
          LEFT JOIN lives l ON l.cliente_id = c.cliente_id
            AND date_trunc('month', l.encerrado_em) = date_trunc('month', $1::date)
          WHERE c.status = 'ativo'
        ),
        custos_mes AS (
          SELECT COALESCE(SUM(valor), 0) AS total_custos
          FROM custos
          WHERE date_trunc('month', competencia) = date_trunc('month', $1::date)
        )
        SELECT
          cm.fat_bruto_fixo,
          cm.fat_bruto_comissao,
          cu.total_custos
        FROM contratos_mes cm
        CROSS JOIN custos_mes cu
      `, [periodo])

      const r = result.rows[0]
      const fat_bruto  = toNum(r.fat_bruto_fixo) + toNum(r.fat_bruto_comissao)
      const fat_liquido = Math.max(0, fat_bruto - toNum(r.total_custos))
      return { fat_bruto, fat_liquido, total_custos: toNum(r.total_custos), periodo }
    })
  })

  // GET /v1/financeiro/faturamento?periodo=YYYY-MM
  app.get('/v1/financeiro/faturamento', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request) => {
    const { tenant_id } = request.user
    const periodo = (request.query.periodo ?? new Date().toISOString().slice(0, 7)) + '-01'

    return app.withTenant(tenant_id, async (db) => {
      const porCliente = await db.query(`
        SELECT cl.nome, cl.nicho, COALESCE(SUM(l.fat_gerado), 0) AS total
        FROM clientes cl
        LEFT JOIN lives l ON l.cliente_id = cl.id
          AND date_trunc('month', l.encerrado_em) = date_trunc('month', $1::date)
        WHERE cl.status = 'ativo'
        GROUP BY cl.id, cl.nome, cl.nicho
        ORDER BY total DESC
      `, [periodo])

      return {
        periodo,
        por_cliente: porCliente.rows.map(r => ({ ...r, total: toNum(r.total) })),
      }
    })
  })

  // GET /v1/financeiro/fluxo-caixa?mes=&ano=
  app.get('/v1/financeiro/fluxo-caixa', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request) => {
    const { tenant_id } = request.user
    const { mes, ano } = request.query
    const periodo = mes && ano
      ? `${ano}-${String(mes).padStart(2, '0')}-01`
      : new Date().toISOString().slice(0, 7) + '-01'

    return app.withTenant(tenant_id, async (db) => {
      const entradas = await db.query(`
        SELECT date_trunc('day', encerrado_em) AS dia, SUM(fat_gerado) AS valor
        FROM lives
        WHERE date_trunc('month', encerrado_em) = date_trunc('month', $1::date)
        GROUP BY 1 ORDER BY 1
      `, [periodo])

      const saidas = await db.query(`
        SELECT competencia AS dia, SUM(valor) AS valor
        FROM custos
        WHERE date_trunc('month', competencia) = date_trunc('month', $1::date)
        GROUP BY 1 ORDER BY 1
      `, [periodo])

      return {
        periodo,
        entradas: entradas.rows.map(r => ({ ...r, valor: toNum(r.valor) })),
        saidas:   saidas.rows.map(r => ({ ...r, valor: toNum(r.valor) })),
      }
    })
  })

  // POST /v1/financeiro/custos
  app.post('/v1/financeiro/custos', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request, reply) => {
    const parsed = custoSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { descricao, valor, tipo, competencia } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `INSERT INTO custos (tenant_id, descricao, valor, tipo, competencia)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, descricao, valor, tipo, competencia`,
        [tenant_id, descricao, valor, tipo, competencia]
      )
      const row = result.rows[0]
      return reply.code(201).send({ ...row, valor: toNum(row.valor) })
    })
  })

  // GET /v1/financeiro/custos
  app.get('/v1/financeiro/custos', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request) => {
    const { tenant_id } = request.user
    const mes = request.query.mes ?? new Date().toISOString().slice(0, 7)
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT id, descricao, valor, tipo, competencia
         FROM custos
         WHERE date_trunc('month', competencia) = date_trunc('month', ($1 || '-01')::date)
         ORDER BY competencia DESC`,
        [mes]
      )
      return result.rows.map(r => ({ ...r, valor: toNum(r.valor) }))
    })
  })

  // DELETE /v1/financeiro/custos/:id
  app.delete('/v1/financeiro/custos/:id', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM custos WHERE id = $1 RETURNING id`, [request.params.id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Custo não encontrado' })
      return { ok: true }
    })
  })
}
