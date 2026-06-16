import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'
import { liveGmvSql, liveOrdersSql } from '../lib/metric-sql.js'

const custoSchema = z.object({
  descricao:   z.string().min(1),
  valor:       moneySchema.refine((value) => value > 0, 'Valor deve ser positivo'),
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
      // FONTE ÚNICA DA VERDADE: GMV/pedidos/comissão derivam de `lives` (cadastro do
      // franqueado em Conteúdo/Operacional) + `video_registros`. NÃO dependemos mais de
      // vendas_atribuidas (ponte condicional) — lives sem marca também entram aqui.
      // receita_liquida = comissão de franquia já gravada por live (lives.comissao_calculada).
      const result = await db.query(`
        WITH live_periodo AS (
          SELECT
            COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_lives,
            COALESCE(SUM(${liveOrdersSql('l')}), 0)::int AS pedidos_lives,
            COUNT(*)::int AS total_lives,
            COALESCE(SUM(l.comissao_calculada), 0) AS comissao_franquia_lives,
            COALESCE(SUM(CASE WHEN COALESCE(l.comissao_calculada, 0) > 0 THEN 1 ELSE 0 END), 0)::int AS comissao_configurada,
            COALESCE(SUM(CASE WHEN COALESCE(l.comissao_calculada, 0) = 0 THEN 1 ELSE 0 END), 0)::int AS comissao_faltante_count
          FROM lives l
          WHERE l.tenant_id = $3::uuid
            AND l.status = 'encerrada'
            AND l.iniciado_em::date >= $1::date
            AND l.iniciado_em::date <= $2::date
        ),
        video_periodo AS (
          SELECT
            COALESCE(SUM(vr.gmv_atribuido), 0) AS gmv_videos,
            COALESCE(SUM(vr.pedidos_atribuidos), 0)::int AS pedidos_videos,
            COUNT(*)::int AS total_videos
          FROM video_registros vr
          WHERE vr.tenant_id = $3::uuid
            AND vr.data >= $1::date
            AND vr.data <= $2::date
        ),
        custos_periodo AS (
          SELECT COALESCE(SUM(valor), 0) AS total_custos
          FROM custos
          WHERE tenant_id = $3::uuid
            AND competencia >= $1::date
            AND competencia <= $2::date
        )
        SELECT lp.gmv_lives, lp.pedidos_lives, lp.total_lives,
               lp.comissao_franquia_lives, lp.comissao_configurada, lp.comissao_faltante_count,
               vp.gmv_videos, vp.pedidos_videos, vp.total_videos,
               cu.total_custos
        FROM live_periodo lp, video_periodo vp, custos_periodo cu
      `, [startDate, endDate, tenant_id])

      const r = result.rows[0]
      const fat_bruto = toNum(r.gmv_lives) + toNum(r.gmv_videos)
      const receita_liquida = toNum(r.comissao_franquia_lives)
      const fat_liquido = Math.max(0, receita_liquida - toNum(r.total_custos))
      return {
        visao,
        fat_bruto,
        fat_liquido,
        gmv_total: fat_bruto,
        gmv_lives: toNum(r.gmv_lives),
        gmv_videos: toNum(r.gmv_videos),
        pedidos: toNum(r.pedidos_lives) + toNum(r.pedidos_videos),
        total_lives: toNum(r.total_lives),
        total_videos: toNum(r.total_videos),
        receita_liquida,
        comissao_configurada: toNum(r.comissao_configurada),
        comissao_faltante_count: toNum(r.comissao_faltante_count),
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
    // Zerados por ora — o usuário vai configurar depois (devem vir de contrato/config da franqueadora).
    const ROYALTY_PCT = 0
    const MARKETING_PCT = 0
    // Respeita o período informado (inicio/fim ou mes/ano); default = mês corrente.
    const { startDate, endDate } = resolveRange(request.query)
    const result = await app.db.query(`
      SELECT
        t.id                                                              AS tenant_id,
        t.nome                                                            AS franqueado_nome,
        t.cidade,
        t.uf,
        t.plano,
        COALESCE(SUM(${liveGmvSql('l')}), 0)::float                       AS gmv_total,
        COALESCE(COUNT(l.id), 0)::int                                     AS total_lives,
        COALESCE(SUM(${liveGmvSql('l')}) * ${ROYALTY_PCT}, 0)::float      AS royalties_estimados,
        COALESCE(SUM(${liveGmvSql('l')}) * ${MARKETING_PCT}, 0)::float    AS taxa_marketing_estimada
      FROM tenants t
      -- Filtra apenas tenants cujo dono tem papel 'franqueado' (não franqueador_master)
      INNER JOIN users u ON u.tenant_id = t.id AND u.papel = 'franqueado'
      LEFT JOIN lives l ON l.tenant_id = t.id
        AND l.status = 'encerrada'
        AND l.iniciado_em::date >= $1::date
        AND l.iniciado_em::date <= $2::date
      GROUP BY t.id, t.nome, t.cidade, t.uf, t.plano
      ORDER BY gmv_total DESC
    `, [startDate, endDate])

    const franqueados = result.rows
    // Agregados de topo que o frontend lê nos cards (antes inexistentes → cards zerados).
    const total_gmv = franqueados.reduce((s, r) => s + toNum(r.gmv_total), 0)
    const total_royalties = franqueados.reduce((s, r) => s + toNum(r.royalties_estimados), 0)
    const total_marketing = franqueados.reduce((s, r) => s + toNum(r.taxa_marketing_estimada), 0)
    return {
      franqueados,
      total_gmv,
      total_royalties,
      total_marketing,
      total_franqueados: franqueados.length,
      periodo: startDate,
      inicio: startDate,
      fim: endDate,
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
      // Agrupa por cliente (ou pela própria marca, quando afiliada sem cliente).
      // Lives e vídeos reais; live sem marca mas com cliente é atribuída ao cliente.
      const porCliente = await db.query(`
        WITH base AS (
          SELECT l.cliente_id, l.marca_id,
                 ${liveGmvSql('l')} AS gmv,
                 COALESCE(l.comissao_calculada, 0) AS comissao_franquia,
                 1 AS is_live, 0 AS is_video
          FROM lives l
          WHERE l.tenant_id = $3::uuid
            AND l.status = 'encerrada'
            AND l.iniciado_em::date >= $1::date
            AND l.iniciado_em::date <= $2::date
          UNION ALL
          SELECT m.cliente_id, vr.marca_id,
                 vr.gmv_atribuido AS gmv,
                 0 AS comissao_franquia,
                 0 AS is_live, 1 AS is_video
          FROM video_registros vr
          JOIN marcas m ON m.id = vr.marca_id AND m.tenant_id = vr.tenant_id
          WHERE vr.tenant_id = $3::uuid
            AND vr.data >= $1::date
            AND vr.data <= $2::date
        ),
        agg AS (
          SELECT COALESCE(cliente_id, marca_id) AS group_id,
                 COALESCE(SUM(gmv), 0) AS total,
                 COALESCE(SUM(comissao_franquia), 0) AS receita_liquida,
                 COALESCE(SUM(is_live), 0)::int AS lives_mes,
                 COALESCE(SUM(is_video), 0)::int AS videos_mes
          FROM base
          GROUP BY COALESCE(cliente_id, marca_id)
        )
        SELECT
          agg.group_id AS id,
          COALESCE(cl.nome, m.nome, 'Sem marca') AS nome,
          COALESCE(cl.nicho, m.tipo) AS nicho,
          CASE WHEN cl.id IS NOT NULL THEN 'cliente_ecommerce' ELSE COALESCE(m.tipo, 'sem_marca') END AS tipo_operacional,
          agg.total, agg.receita_liquida, agg.lives_mes, agg.videos_mes
        FROM agg
        LEFT JOIN clientes cl ON cl.id = agg.group_id AND cl.tenant_id = $3::uuid
        LEFT JOIN marcas m ON m.id = agg.group_id AND m.tenant_id = $3::uuid
        ORDER BY agg.total DESC
      `, [startDate, endDate, tenant_id])

      return {
        periodo: startDate,
        inicio: startDate,
        fim: endDate,
        por_cliente: porCliente.rows.map(r => ({
          ...r,
          total: toNum(r.total),
          gmv_mes: toNum(r.total),
          receita_liquida: toNum(r.receita_liquida),
          lives_mes: toNum(r.lives_mes),
          videos_mes: toNum(r.videos_mes),
        })),
      }
    })
  })

  // GET /v1/financeiro/fluxo-caixa?mes=&ano=  OR  ?inicio=YYYY-MM&fim=YYYY-MM
  app.get('/v1/financeiro/fluxo-caixa', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id } = request.user
    const { startDate, endDate } = resolveRange(request.query)

    return app.withTenant(tenant_id, async (db) => {
      // Entradas = GMV real por dia (lives encerradas + vídeos), não mais vendas_atribuidas
      // (que referenciava colunas inexistentes va.data_referencia/va.status → 500).
      const entradas = await db.query(`
        SELECT dia, SUM(valor)::numeric AS valor FROM (
          SELECT l.iniciado_em::date AS dia, ${liveGmvSql('l')} AS valor
          FROM lives l
          WHERE l.tenant_id = $3::uuid
            AND l.status = 'encerrada'
            AND l.iniciado_em::date >= $1::date
            AND l.iniciado_em::date <= $2::date
          UNION ALL
          SELECT vr.data AS dia, vr.gmv_atribuido AS valor
          FROM video_registros vr
          WHERE vr.tenant_id = $3::uuid
            AND vr.data >= $1::date
            AND vr.data <= $2::date
        ) t
        GROUP BY dia ORDER BY dia
      `, [startDate, endDate, tenant_id])

      const saidas = await db.query(`
        SELECT competencia AS dia, SUM(valor) AS valor
        FROM custos
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND competencia >= $1::date
          AND competencia <  ($2::date + interval '1 day')
        GROUP BY 1 ORDER BY 1
      `, [startDate, endDate])

      const entradasRows = entradas.rows.map(r => ({ ...r, valor: toNum(r.valor) }))
      const saidasRows = saidas.rows.map(r => ({ ...r, valor: toNum(r.valor) }))
      const days = new Map()
      for (const row of entradasRows) {
        const key = row.dia instanceof Date ? row.dia.toISOString().slice(0, 10) : String(row.dia).slice(0, 10)
        days.set(key, { dia: key, entradas: row.valor, saidas: 0 })
      }
      for (const row of saidasRows) {
        const key = row.dia instanceof Date ? row.dia.toISOString().slice(0, 10) : String(row.dia).slice(0, 10)
        const current = days.get(key) ?? { dia: key, entradas: 0, saidas: 0 }
        current.saidas = row.valor
        days.set(key, current)
      }

      return {
        periodo: startDate,
        inicio: startDate,
        fim: endDate,
        entradas: entradasRows,
        saidas: saidasRows,
        items: [...days.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
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
