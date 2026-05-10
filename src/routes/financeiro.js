import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'

const custoSchema = z.object({
  descricao:   z.string().min(1),
  valor:       z.number().positive(),
  tipo:        z.enum(['aluguel','salario','energia','internet','outros']),
  competencia: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'Formato: YYYY-MM ou YYYY-MM-DD'),
})

const toNum = (v) => Number(v ?? 0)

/**
 * Resolve [inicio, fim] como datas YYYY-MM-DD a partir dos query params.
 * Aceita: inicio=YYYY-MM, fim=YYYY-MM (range), ou mes+ano (single month),
 * ou nada (fallback: mês corrente).
 *
 * Retorna: { startDate, endDate } onde startDate é o primeiro dia do mês `inicio`
 * e endDate é o último dia do mês `fim` (inclusive).
 */
function resolveRange({ inicio, fim, mes, ano }) {
  // Range explícito (frontend manda 'inicio' e 'fim' em YYYY-MM)
  if (inicio && fim && /^\d{4}-\d{2}$/.test(inicio) && /^\d{4}-\d{2}$/.test(fim)) {
    const startDate = `${inicio}-01`
    const [fy, fm] = fim.split('-').map(Number)
    const endDate = new Date(Date.UTC(fy, fm, 0)).toISOString().slice(0, 10) // último dia do mês fim
    return { startDate, endDate }
  }
  // Mês único via mes+ano
  if (mes && ano) {
    const m = String(mes).padStart(2, '0')
    const startDate = `${ano}-${m}-01`
    const endDate = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10)
    return { startDate, endDate }
  }
  // Fallback: mês atual
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  const startDate = `${y}-${String(m).padStart(2, '0')}-01`
  const endDate = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  return { startDate, endDate }
}

export async function financeiroRoutes(app) {
  // GET /v1/financeiro/resumo?mes=&ano=  OR  ?inicio=YYYY-MM&fim=YYYY-MM
  app.get('/v1/financeiro/resumo', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id } = request.user
    const { startDate, endDate } = resolveRange(request.query)

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(`
        WITH contratos_periodo AS (
          SELECT
            -- Fixo proporcional ao número de meses no range.
            -- Mês único (mai-mai) deve dar 1, range mai-jul deve dar 3.
            -- Fórmula: meses_diff + (1 se dia_fim >= dia_início, senão 0).
            COALESCE(SUM(c.valor_fixo), 0) *
              GREATEST(1::numeric,
                (DATE_PART('year', $2::date) - DATE_PART('year', $1::date)) * 12
                + DATE_PART('month', $2::date) - DATE_PART('month', $1::date)
                + CASE WHEN DATE_PART('day', $2::date) >= DATE_PART('day', $1::date) THEN 1 ELSE 0 END
              )::numeric
              AS fat_bruto_fixo,
            COALESCE(SUM(l.fat_gerado * c.comissao_pct / 100.0), 0) AS fat_bruto_comissao
          FROM contratos c
          LEFT JOIN lives l ON l.cliente_id = c.cliente_id
            AND l.encerrado_em >= $1::date
            AND l.encerrado_em <  ($2::date + interval '1 day')
          WHERE c.status = 'ativo'
        ),
        custos_periodo AS (
          SELECT COALESCE(SUM(valor), 0) AS total_custos
          FROM custos
          WHERE competencia >= $1::date
            AND competencia <  ($2::date + interval '1 day')
        )
        SELECT
          cm.fat_bruto_fixo,
          cm.fat_bruto_comissao,
          cu.total_custos
        FROM contratos_periodo cm
        CROSS JOIN custos_periodo cu
      `, [startDate, endDate])

      const r = result.rows[0]
      const fat_bruto  = toNum(r.fat_bruto_fixo) + toNum(r.fat_bruto_comissao)
      const fat_liquido = Math.max(0, fat_bruto - toNum(r.total_custos))
      return {
        fat_bruto,
        fat_liquido,
        total_custos: toNum(r.total_custos),
        periodo: startDate,
        inicio: startDate,
        fim: endDate,
      }
    })
  })

  // GET /v1/financeiro/faturamento?periodo=YYYY-MM  OR  ?inicio=YYYY-MM&fim=YYYY-MM
  app.get('/v1/financeiro/faturamento', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id } = request.user
    // Aceita 'periodo' legado (YYYY-MM) como atalho
    const q = { ...request.query }
    if (!q.inicio && !q.fim && q.periodo && /^\d{4}-\d{2}$/.test(q.periodo)) {
      q.inicio = q.periodo
      q.fim = q.periodo
    }
    const { startDate, endDate } = resolveRange(q)

    return app.withTenant(tenant_id, async (db) => {
      const porCliente = await db.query(`
        SELECT cl.nome, cl.nicho, COALESCE(SUM(l.fat_gerado), 0) AS total
        FROM clientes cl
        LEFT JOIN lives l ON l.cliente_id = cl.id AND l.tenant_id = cl.tenant_id
          AND l.encerrado_em >= $1::date
          AND l.encerrado_em <  ($2::date + interval '1 day')
        WHERE cl.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND cl.status = 'ativo'
        GROUP BY cl.id, cl.nome, cl.nicho
        ORDER BY total DESC
      `, [startDate, endDate])

      return {
        periodo: startDate,
        inicio: startDate,
        fim: endDate,
        por_cliente: porCliente.rows.map(r => ({ ...r, total: toNum(r.total) })),
      }
    })
  })

  // GET /v1/financeiro/fluxo-caixa?mes=&ano=  OR  ?inicio=YYYY-MM&fim=YYYY-MM
  app.get('/v1/financeiro/fluxo-caixa', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id } = request.user
    const { startDate, endDate } = resolveRange(request.query)

    return app.withTenant(tenant_id, async (db) => {
      const entradas = await db.query(`
        SELECT date_trunc('day', encerrado_em) AS dia, SUM(fat_gerado) AS valor
        FROM lives
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND encerrado_em >= $1::date
          AND encerrado_em <  ($2::date + interval '1 day')
        GROUP BY 1 ORDER BY 1
      `, [startDate, endDate])

      const saidas = await db.query(`
        SELECT competencia AS dia, SUM(valor) AS valor
        FROM custos
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND competencia >= $1::date
          AND competencia <  ($2::date + interval '1 day')
        GROUP BY 1 ORDER BY 1
      `, [startDate, endDate])

      return {
        periodo: startDate,
        inicio: startDate,
        fim: endDate,
        entradas: entradas.rows.map(r => ({ ...r, valor: toNum(r.valor) })),
        saidas:   saidas.rows.map(r => ({ ...r, valor: toNum(r.valor) })),
      }
    })
  })

  // POST /v1/financeiro/custos
  app.post('/v1/financeiro/custos', { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
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

  // GET /v1/financeiro/custos?mes=YYYY-MM  OR  ?inicio=YYYY-MM&fim=YYYY-MM
  app.get('/v1/financeiro/custos', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id } = request.user
    const q = { ...request.query }
    // Atalho: legado mandava 'mes=YYYY-MM' (string). Converte para inicio/fim iguais.
    if (q.mes && !q.inicio && !q.fim && /^\d{4}-\d{2}$/.test(String(q.mes))) {
      q.inicio = String(q.mes)
      q.fim = String(q.mes)
    }
    const { startDate, endDate } = resolveRange(q)

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT id, descricao, valor, tipo, competencia
         FROM custos
         WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
           AND competencia >= $1::date
           AND competencia <  ($2::date + interval '1 day')
         ORDER BY competencia DESC`,
        [startDate, endDate]
      )
      return result.rows.map(r => ({ ...r, valor: toNum(r.valor) }))
    })
  })

  // DELETE /v1/financeiro/custos/:id
  app.delete('/v1/financeiro/custos/:id', { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM custos WHERE id = $1 AND tenant_id = $2::uuid RETURNING id`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Custo não encontrado' })
      return { ok: true }
    })
  })
}
