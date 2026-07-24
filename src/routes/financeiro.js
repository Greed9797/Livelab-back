import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'
import { liveGmvSql, liveOrdersSql } from '../lib/metric-sql.js'
import { marcaResolveLateralSql, MARCA_RESOLVE_PREDICATE } from '../lib/marca-sql.js'
import { resolveMonthRange } from '../lib/operacional.js'
import { presenterFixedSql } from '../config/presenter_defaults.js'
import { performance } from 'node:perf_hooks'
import { withCache, buildCacheKey, setCacheControl } from '../lib/dashboard-cache.js'

const FINANCEIRO_RESUMO_CACHE_TTL_MS = Number(process.env.FINANCEIRO_RESUMO_CACHE_TTL_MS ?? 45_000)

const custoSchema = z.object({
  descricao:   z.string().min(1),
  valor:       moneySchema.refine((value) => value > 0, 'Valor deve ser positivo'),
  tipo:        z.enum(['aluguel','salario','energia','internet','outros']),
  competencia: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'Formato: YYYY-MM ou YYYY-MM-DD'),
})

const toNum = (v) => Number(v ?? 0)

// Fração de um mês (`mesExpr` = timestamp no 1º dia do mês) coberta pelo contrato
// [inicioCol, fimCol]. Datas NULL → 1.0 (mês cheio, comportamento pré-133). Clamp [0,1].
// ponytail: rateio por dias (saiu dia 15 de 30 → 0.5; mês fora do contrato → 0). Exato quando
// o range = 1 mês (o default dos painéis); em range multi-mês a marca soma fração por mês ativo
// e a apresentadora usa só o mês de referência. Reusa o padrão EXTRACT(DAY) do home.js.
function prorateFatorSql(mesExpr, inicioCol, fimCol) {
  const ini = `(${mesExpr})::date`
  const fim = `((${mesExpr}) + interval '1 month' - interval '1 day')::date`
  return `GREATEST(0, LEAST(1.0,
    (LEAST(${fim}, COALESCE(${fimCol}, ${fim})) - GREATEST(${ini}, COALESCE(${inicioCol}, ${ini})) + 1)::numeric
    / EXTRACT(DAY FROM (${fim}))::numeric
  ))`
}

// Fixo mensal das marcas tipo='cliente' (semântica migration 116): 1× por marca por mês
// COM atividade (GMV/pedidos > 0 em lives ou vídeos). FONTE ÚNICA compartilhada entre
// /resumo (soma agregada) e /operacional (1 lançamento por marca) — não duplicar.
// `meses_ativos` = contagem inteira de meses (display); `fator_meses` = soma das frações
// rateadas por data_inicio/data_fim da marca (migration 133) — o valor MONETÁRIO usa fator_meses.
// Params posicionais fixos: $1=startDate, $2=endDate, $3=tenant_id.
function marcaFixoMensalSql() {
  return `
    SELECT m.id AS marca_id, m.nome AS marca_nome, m.valor_fixo_minimo, m.tipo_cobranca,
           am.meses_ativos, am.fator_meses
    FROM marcas m
    JOIN (
      SELECT am2.marca_id,
             COUNT(*)::int AS meses_ativos,
             COALESCE(SUM(${prorateFatorSql('am2.mes', 'mk.data_inicio', 'mk.data_fim')}), 0) AS fator_meses
      FROM (
        SELECT DISTINCT marca_id, mes FROM (
          SELECT l.marca_id, date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo') AS mes
          FROM lives l
          WHERE l.tenant_id = $3::uuid AND l.status = 'encerrada' AND l.marca_id IS NOT NULL
            AND l.iniciado_em >= ($1::date) AT TIME ZONE 'America/Sao_Paulo'
            AND l.iniciado_em < (($2::date) + 1) AT TIME ZONE 'America/Sao_Paulo'
            AND (${liveGmvSql('l')} > 0 OR ${liveOrdersSql('l')} > 0)
          UNION
          SELECT vr.marca_id, date_trunc('month', vr.data::timestamp) AS mes
          FROM video_registros vr
          WHERE vr.tenant_id = $3::uuid
            AND vr.data >= $1::date AND vr.data <= $2::date
            AND (vr.gmv_atribuido > 0 OR vr.pedidos_atribuidos > 0)
        ) u
      ) am2
      JOIN marcas mk ON mk.id = am2.marca_id AND mk.tenant_id = $3::uuid
      GROUP BY am2.marca_id
    ) am ON am.marca_id = m.id
    WHERE m.tenant_id = $3::uuid AND m.tipo = 'cliente'`
}

// Vendas reprovadas NUNCA entram em soma financeira (mesmo predicado de lib/operacional.js).
const VENDA_NAO_REPROVADA = `COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'`

// Classificação fixa × variável dos totais do resultado operacional:
//   despesas_fixas     = fixo_apresentadora + custos manuais tipo aluguel/salario/energia/internet
//   despesas_variaveis = comissao_apresentadora + custos manuais tipo 'outros'
// (comissao_franquia e fixo_marca são ENTRADAS — receita da operação)
const CUSTO_TIPOS_FIXOS = new Set(['aluguel', 'salario', 'energia', 'internet'])

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
  app.get('/v1/financeiro/resumo', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request, reply) => {
    const { tenant_id, papel } = request.user
    const { startDate, endDate } = resolveRange(request.query)

    // PR 13: determina visão baseada no papel e scope solicitado
    const scopeParam = request.query.scope
    const isMaster = papel === 'franqueador_master'
    const visao = (isMaster && scopeParam === 'franqueadora') ? 'franqueadora' : 'unidade'

    const startedAt = performance.now()
    const cacheKey = buildCacheKey(tenant_id, { start: startDate, end: endDate, visao })
    const { value, state } = await withCache({
      namespace: 'financeiro:resumo',
      key: cacheKey,
      ttlMs: FINANCEIRO_RESUMO_CACHE_TTL_MS,
      computeFn: () => app.withTenant(tenant_id, async (db) => {
      // FONTE ÚNICA DA VERDADE: GMV/pedidos/comissão derivam de `lives` (cadastro do
      // franqueado em Conteúdo/Operacional) + `video_registros`. NÃO dependemos mais de
      // vendas_atribuidas (ponte condicional) — lives sem marca também entram aqui.
      // receita_liquida = comissão de franquia VARIÁVEL calculada INLINE (gmv × pct da marca
      // resolvida) + fixo mensal das marcas. NÃO depende mais da coluna pré-calculada
      // lives.comissao_calculada (ficava 0 em lives recentes ainda não processadas pelo motor
      // → Financeiro "parava" no meio do mês enquanto o GMV/Analytics mostravam o mês inteiro).
      const result = await db.query(`
        WITH live_periodo AS (
          SELECT
            COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv_lives,
            COALESCE(SUM(${liveOrdersSql('l')}), 0)::int AS pedidos_lives,
            COUNT(*)::int AS total_lives,
            -- comissão de franquia variável = gmv × pct da marca resolvida (MESMA regra de
            -- comissao.js/commission-engine), calculada na hora — sem coluna estagnada.
            COALESCE(SUM(${liveGmvSql('l')} * COALESCE(mc.comissao_franquia_pct, 0) / 100.0), 0) AS comissao_franquia_lives,
            COALESCE(SUM(CASE WHEN mc.id IS NOT NULL AND COALESCE(mc.comissao_franquia_pct, 0) > 0 THEN 1 ELSE 0 END), 0)::int AS comissao_configurada,
            -- "faltante" agora = live COM gmv mas SEM marca/pct resolvível (problema real de
            -- config), não mais um artefato de timing do motor de comissão.
            COALESCE(SUM(CASE WHEN ${liveGmvSql('l')} > 0 AND (mc.id IS NULL OR COALESCE(mc.comissao_franquia_pct, 0) = 0) THEN 1 ELSE 0 END), 0)::int AS comissao_faltante_count
          FROM lives l
          ${marcaResolveLateralSql('$3')}
          WHERE l.tenant_id = $3::uuid
            AND l.status = 'encerrada'
            AND l.iniciado_em >= ($1::date) AT TIME ZONE 'America/Sao_Paulo'
            AND l.iniciado_em < (($2::date) + 1) AT TIME ZONE 'America/Sao_Paulo'
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
        ),
        -- Comissão de franquia VARIÁVEL por marca (gmv × pct), mesma fonte do live_periodo mas
        -- agrupada por marca resolvida — pra combinar com o fixo POR marca conforme tipo_cobranca.
        comissao_marca AS (
          SELECT mc.id AS marca_id,
                 COALESCE(SUM(${liveGmvSql('l')} * COALESCE(mc.comissao_franquia_pct, 0) / 100.0), 0) AS comissao
          FROM lives l
          ${marcaResolveLateralSql('$3')}
          WHERE l.tenant_id = $3::uuid
            AND l.status = 'encerrada'
            AND l.iniciado_em >= ($1::date) AT TIME ZONE 'America/Sao_Paulo'
            AND l.iniciado_em < (($2::date) + 1) AT TIME ZONE 'America/Sao_Paulo'
            AND mc.id IS NOT NULL
          GROUP BY mc.id
        ),
        -- Fixo mensal das marcas tipo='cliente': valor_fixo_minimo × meses ativos (migration 116).
        -- Fonte compartilhada marcaFixoMensalSql() — mesma do /operacional e performance-rollups.js.
        fixo_marca AS (
          SELECT mf.marca_id, mf.tipo_cobranca, (mf.valor_fixo_minimo * mf.fator_meses) AS fixo
          FROM (${marcaFixoMensalSql()}) mf
        ),
        -- Entrada POR marca: junta comissão variável e fixo mensal; tipo_cobranca decide se soma
        -- (fixo_mais_comissao) ou pega o maior (fixo_ou_comissao). Default preserva o aditivo.
        entrada_marca AS (
          SELECT COALESCE(cm.marca_id, fm.marca_id) AS marca_id,
                 COALESCE(cm.comissao, 0) AS comissao,
                 COALESCE(fm.fixo, 0) AS fixo,
                 COALESCE(fm.tipo_cobranca, mk.tipo_cobranca, 'fixo_mais_comissao') AS tipo_cobranca
          FROM comissao_marca cm
          FULL OUTER JOIN fixo_marca fm ON fm.marca_id = cm.marca_id
          LEFT JOIN marcas mk ON mk.id = cm.marca_id AND mk.tenant_id = $3::uuid
        ),
        totais_marca AS (
          SELECT
            COALESCE(SUM(fixo), 0) AS fixo_mensal_total,
            COALESCE(SUM(
              CASE WHEN tipo_cobranca = 'fixo_ou_comissao' THEN GREATEST(fixo, comissao)
                   ELSE fixo + comissao END
            ), 0) AS receita_combinada
          FROM entrada_marca
        )
        SELECT lp.gmv_lives, lp.pedidos_lives, lp.total_lives,
               lp.comissao_franquia_lives, lp.comissao_configurada, lp.comissao_faltante_count,
               vp.gmv_videos, vp.pedidos_videos, vp.total_videos,
               cu.total_custos, tm.fixo_mensal_total, tm.receita_combinada
        FROM live_periodo lp, video_periodo vp, custos_periodo cu, totais_marca tm
      `, [startDate, endDate, tenant_id])

      const r = result.rows[0]
      const fat_bruto = toNum(r.gmv_lives) + toNum(r.gmv_videos)
      // receita_liquida = combinação POR marca de (comissão variável, fixo mensal) conforme
      // tipo_cobranca: fixo_mais_comissao soma; fixo_ou_comissao pega o maior. Ver combinarEntradaMarca.
      const receita_liquida = toNum(r.receita_combinada)
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
        fixo_mensal: toNum(r.fixo_mensal_total),
        comissao_configurada: toNum(r.comissao_configurada),
        comissao_faltante_count: toNum(r.comissao_faltante_count),
        total_custos: toNum(r.total_custos),
        periodo: startDate,
        inicio: startDate,
        fim: endDate,
      }
      }),
    })
    setCacheControl(reply, state, startedAt)
    return value
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
    // MASTER: visão consolidada cross-tenant do franqueador_master (agrega todos os tenants). Sem RLS por design.
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
                 -- comissão de franquia inline (gmv × pct da marca resolvida), não da coluna
                 -- pré-calculada/estagnada do motor — mantém o breakdown por cliente coerente
                 -- com /resumo e com a aba Comissões.
                 ${liveGmvSql('l')} * COALESCE(mc.comissao_franquia_pct, 0) / 100.0 AS comissao_franquia,
                 1 AS is_live, 0 AS is_video
          FROM lives l
          ${marcaResolveLateralSql('$3')}
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

  // GET /v1/financeiro/operacional?inicio=YYYY-MM&fim=YYYY-MM (default: mês corrente SP)
  // Resultado operacional automático: entradas (comissão de franquia + fixo de marca) −
  // saídas (fixo/comissão de apresentadoras + custos manuais), com memória de cálculo
  // por lançamento. Lançamentos AGREGADOS por entidade (marca/apresentadora), não por venda.
  app.get('/v1/financeiro/operacional', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id } = request.user
    const { startDate, endDate } = resolveMonthRange(request.query)
    const round2 = (v) => Math.round(v * 100) / 100
    const pctMedio = (valor, gmv) => (gmv > 0 ? round2((valor / gmv) * 100) : 0)

    return app.withTenant(tenant_id, async (db) => {
      // ENTRADA: comissão de franquia por marca (vendas não-reprovadas do período)
      const comissaoFranquia = await db.query(`
        SELECT va.marca_id, m.nome AS marca_nome, m.tipo_cobranca,
               COALESCE(SUM(va.comissao_franquia), 0) AS valor,
               COALESCE(SUM(va.gmv), 0) AS gmv,
               COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'live')::int AS lives
        FROM vendas_atribuidas va
        JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
        WHERE va.tenant_id = $3::uuid
          AND va.data >= $1::date AND va.data <= $2::date
          AND ${VENDA_NAO_REPROVADA}
        GROUP BY va.marca_id, m.nome, m.tipo_cobranca
        HAVING COALESCE(SUM(va.comissao_franquia), 0) <> 0
        ORDER BY valor DESC
      `, [startDate, endDate, tenant_id])

      // ENTRADA: fixo mensal por marca tipo=cliente com atividade (mesma fonte do /resumo)
      const fixoMarcas = await db.query(`
        SELECT mf.marca_id, mf.marca_nome, mf.valor_fixo_minimo, mf.tipo_cobranca, mf.meses_ativos, mf.fator_meses
        FROM (${marcaFixoMensalSql()}) mf
        WHERE mf.valor_fixo_minimo > 0
        ORDER BY mf.valor_fixo_minimo DESC
      `, [startDate, endDate, tenant_id])

      // SAÍDA: comissão por apresentadora (vendas não-reprovadas do período)
      const comissaoApresentadoras = await db.query(`
        SELECT va.apresentadora_id, a.nome,
               COALESCE(SUM(va.comissao_apresentadora), 0) AS valor,
               COALESCE(SUM(va.gmv), 0) AS gmv
        FROM vendas_atribuidas va
        JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
        WHERE va.tenant_id = $3::uuid
          AND va.data >= $1::date AND va.data <= $2::date
          AND ${VENDA_NAO_REPROVADA}
        GROUP BY va.apresentadora_id, a.nome
        HAVING COALESCE(SUM(va.comissao_apresentadora), 0) <> 0
        ORDER BY valor DESC
      `, [startDate, endDate, tenant_id])

      // SAÍDA: fixo mensal (com cap padrão) das apresentadoras ativas não-arquivadas,
      // rateado por dias de contrato (data_inicio/data_fim, migration 041) no mês de referência
      // ($1 = startDate). Saiu dia 15 → metade; saiu antes do mês → 0; datas NULL → fixo cheio.
      // ponytail: rateia só o mês de $1 (range multi-mês usa o 1º mês); exato no default (1 mês).
      const fixoApresentadoras = await db.query(`
        SELECT a.id AS apresentadora_id, a.nome,
               (${presenterFixedSql('a')}) * ${prorateFatorSql("date_trunc('month', $1::date)", 'a.data_inicio', 'a.data_fim')} AS valor
        FROM apresentadoras a
        WHERE a.tenant_id = $2::uuid AND a.ativo IS TRUE AND COALESCE(a.arquivada, false) = false
        ORDER BY valor DESC, a.nome ASC
      `, [startDate, tenant_id])

      // SAÍDA: custos manuais lançados na competência
      const custosManuais = await db.query(`
        SELECT id, descricao, valor, tipo, competencia
        FROM custos
        WHERE tenant_id = $3::uuid
          AND competencia >= $1::date AND competencia <= $2::date
        ORDER BY valor DESC
      `, [startDate, endDate, tenant_id])

      // Junta comissão variável + fixo mensal POR marca. tipo_cobranca decide a composição da
      // ENTRADAS (mesma regra de combinarEntradaMarca): 'fixo_mais_comissao' soma as duas linhas;
      // 'fixo_ou_comissao' entra só a maior (uma linha vencedora) → total = GREATEST(fixo, comissao).
      const marcaEntradas = new Map()
      for (const r of comissaoFranquia.rows) {
        marcaEntradas.set(r.marca_id, {
          marca_id: r.marca_id,
          marca_nome: r.marca_nome,
          tipo: r.tipo_cobranca || 'fixo_mais_comissao',
          comissao: toNum(r.valor), gmv: toNum(r.gmv), lives: toNum(r.lives),
          fixo: 0, meses_ativos: 0,
        })
      }
      for (const r of fixoMarcas.rows) {
        // valor monetário rateado por dias de contrato (fator_meses); meses_ativos fica só p/ display.
        const fixo = toNum(r.valor_fixo_minimo) * toNum(r.fator_meses)
        const cur = marcaEntradas.get(r.marca_id)
        if (cur) {
          cur.fixo = fixo
          cur.meses_ativos = toNum(r.meses_ativos)
          cur.tipo = r.tipo_cobranca || cur.tipo
        } else {
          marcaEntradas.set(r.marca_id, {
            marca_id: r.marca_id,
            marca_nome: r.marca_nome,
            tipo: r.tipo_cobranca || 'fixo_mais_comissao',
            comissao: 0, gmv: 0, lives: 0,
            fixo, meses_ativos: toNum(r.meses_ativos),
          })
        }
      }

      const entradas = []
      for (const m of marcaEntradas.values()) {
        const linhaComissao = () => ({
          categoria: 'comissao_franquia',
          descricao: `Comissão de franquia — ${m.marca_nome}`,
          valor: m.comissao,
          memoria: { marca_id: m.marca_id, marca_nome: m.marca_nome, gmv: m.gmv, lives: m.lives, pct_medio: pctMedio(m.comissao, m.gmv) },
        })
        const linhaFixo = (criterio) => ({
          categoria: 'fixo_marca',
          descricao: `Fixo mensal — ${m.marca_nome}`,
          valor: m.fixo,
          memoria: { marca_id: m.marca_id, marca_nome: m.marca_nome, criterio, meses_ativos: m.meses_ativos },
        })
        if (m.tipo === 'fixo_ou_comissao') {
          // entra só a maior — uma linha; memória registra o que foi comparado
          if (m.fixo >= m.comissao) {
            if (m.fixo > 0) entradas.push({ ...linhaFixo('fixo_ou_comissao_venceu_fixo'), memoria: { marca_id: m.marca_id, marca_nome: m.marca_nome, criterio: 'fixo_ou_comissao_venceu_fixo', meses_ativos: m.meses_ativos, comissao_comparada: round2(m.comissao) } })
          } else {
            entradas.push({ ...linhaComissao(), memoria: { marca_id: m.marca_id, marca_nome: m.marca_nome, gmv: m.gmv, lives: m.lives, pct_medio: pctMedio(m.comissao, m.gmv), criterio: 'fixo_ou_comissao_venceu_comissao', fixo_comparado: round2(m.fixo) } })
          }
        } else {
          if (m.comissao > 0) entradas.push(linhaComissao())
          if (m.fixo > 0) entradas.push(linhaFixo('mes_com_atividade'))
        }
      }
      entradas.sort((a, b) => b.valor - a.valor)

      const saidas = [
        ...fixoApresentadoras.rows.map((r) => ({
          categoria: 'fixo_apresentadora',
          descricao: `Fixo mensal — ${r.nome}`,
          valor: toNum(r.valor),
          memoria: { apresentadora_id: r.apresentadora_id, nome: r.nome, criterio: 'fixo_mensal' },
        })),
        ...comissaoApresentadoras.rows.map((r) => ({
          categoria: 'comissao_apresentadora',
          descricao: `Comissão — ${r.nome}`,
          valor: toNum(r.valor),
          memoria: {
            apresentadora_id: r.apresentadora_id,
            nome: r.nome,
            gmv_atribuido: toNum(r.gmv),
            pct_medio: pctMedio(toNum(r.valor), toNum(r.gmv)),
          },
        })),
        ...custosManuais.rows.map((r) => ({
          categoria: 'custo_manual',
          descricao: r.descricao,
          valor: toNum(r.valor),
          memoria: { custo_id: r.id, tipo: r.tipo },
        })),
      ]

      const isFixa = (l) => l.categoria === 'fixo_apresentadora'
        || (l.categoria === 'custo_manual' && CUSTO_TIPOS_FIXOS.has(l.memoria.tipo))
      const totalEntradas = entradas.reduce((s, l) => s + l.valor, 0)
      const despesasFixas = saidas.reduce((s, l) => s + (isFixa(l) ? l.valor : 0), 0)
      const despesasVariaveis = saidas.reduce((s, l) => s + (isFixa(l) ? 0 : l.valor), 0)

      return {
        periodo: { inicio: startDate, fim: endDate },
        entradas,
        saidas,
        totais: {
          entradas: round2(totalEntradas),
          despesas_fixas: round2(despesasFixas),
          despesas_variaveis: round2(despesasVariaveis),
          resultado: round2(totalEntradas - despesasFixas - despesasVariaveis),
        },
        // Pendência de schema: supervisor e demais integrantes da equipe não têm
        // remuneração cadastrada — lançar manualmente em custos (tipo 'salario').
        pendencias: ['equipe_sem_remuneracao_no_schema'],
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
