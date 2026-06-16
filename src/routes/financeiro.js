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
  // Query param opcional: ?scope=unidade|franqueadora  (só franqueador_master pode usar franqueadora)
  app.get('/v1/financeiro/resumo', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id, papel } = request.user
    const { startDate, endDate } = resolveRange(request.query)

    // PR 13: determina visão baseada no papel e scope solicitado
    const scopeParam = request.query.scope
    const isMaster = papel === 'franqueador_master'
    const visao = (isMaster && scopeParam === 'franqueadora') ? 'franqueadora' : 'unidade'

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
              AS fat_bruto_fixo
          FROM contratos c
          WHERE c.status = 'ativo'
        ),
        -- Usa o snapshot histórico de comissão gravado em vendas_atribuidas pelo commission-engine,
        -- evitando recalcular com a taxa atual de marcas (o que distorceria relatórios passados).
        comissoes_periodo AS (
          SELECT COALESCE(SUM(va.comissao_franquia), 0) AS fat_bruto_comissao
          FROM vendas_atribuidas va
          WHERE va.data >= $1::date
            AND va.data <  ($2::date + interval '1 day')
        ),
        custos_periodo AS (
          SELECT COALESCE(SUM(valor), 0) AS total_custos
          FROM custos
          WHERE competencia >= $1::date
            AND competencia <  ($2::date + interval '1 day')
        )
        SELECT
          cm.fat_bruto_fixo,
          co.fat_bruto_comissao,
          cu.total_custos
        FROM contratos_periodo cm
        CROSS JOIN comissoes_periodo co
        CROSS JOIN custos_periodo cu
      `, [startDate, endDate])

      const r = result.rows[0]
      const fat_bruto  = toNum(r.fat_bruto_fixo) + toNum(r.fat_bruto_comissao)
      const fat_liquido = Math.max(0, fat_bruto - toNum(r.total_custos))
      return {
        visao,
        fat_bruto,
        fat_liquido,
        total_custos: toNum(r.total_custos),
        periodo: startDate,
        inicio: startDate,
        fim: endDate,
      }
    })
  })

  // GET /v1/financeiro/franqueadora — apenas franqueador_master
  // Retorna visão consolidada: GMV, royalties e taxa de marketing por franqueado
  // PR 13: schema real de tenants não tem coluna "tipo"; identifica franqueados
  // pelo papel do usuário dono do tenant (papel = 'franqueado').
  app.get('/v1/financeiro/franqueadora', {
    preHandler: app.requirePapel(['franqueador_master']),
  }, async (request, reply) => {
    const result = await app.db.query(`
      SELECT
        t.id                                                    AS tenant_id,
        t.nome                                                  AS franqueado_nome,
        t.cidade,
        t.uf,
        t.plano,
        COALESCE(SUM(l.fat_gerado), 0)::float                  AS gmv_total,
        COALESCE(COUNT(l.id), 0)::int                          AS total_lives,
        COALESCE(SUM(l.fat_gerado) * 0.05, 0)::float           AS royalties_estimados,
        COALESCE(SUM(l.fat_gerado) * 0.02, 0)::float           AS taxa_marketing_estimada
      FROM tenants t
      -- Filtra apenas tenants cujo dono tem papel 'franqueado' (não franqueador_master)
      INNER JOIN users u ON u.tenant_id = t.id AND u.papel = 'franqueado'
      LEFT JOIN lives l ON l.tenant_id = t.id
        AND l.status = 'encerrada'
        AND date_trunc('month', l.iniciado_em) = date_trunc('month', NOW())
      GROUP BY t.id, t.nome, t.cidade, t.uf, t.plano
      ORDER BY gmv_total DESC
    `)
    return {
      franqueados: result.rows,
      periodo: new Date().toISOString().slice(0, 7),
    }
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
        SELECT cl.nome, cl.nicho, COALESCE(SUM(COALESCE(l.manual_gmv, l.fat_gerado)), 0) AS total
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
      app.audit?.log?.(request, { action: 'financeiro.custo_create', entity_type: 'custo', entity_id: row.id, metadata: { descricao, tipo, valor } })?.catch(err => app.log.error({ err }, 'audit log failed'))
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
      app.audit?.log?.(request, { action: 'financeiro.custo_delete', entity_type: 'custo', entity_id: request.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return { ok: true }
    })
  })
}
