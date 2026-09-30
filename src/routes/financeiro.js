import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'
import { liveGmvSql, liveOrdersSql } from '../lib/metric-sql.js'
import { officialLineCommissionExpr, officialLineGmvExpr } from '../lib/sale-gmv-sql.js'
import { marcaResolveLateralSql, MARCA_RESOLVE_PREDICATE } from '../lib/marca-sql.js'
import { resolveMonthRange } from '../lib/operacional.js'
import { presenterFixedAtSql } from '../config/presenter_defaults.js'
import { prorateFatorSql } from '../lib/financeiro-remuneracao.js'
import { performance } from 'node:perf_hooks'
import { withCache, buildCacheKey, setCacheControl, invalidateTenant } from '../lib/dashboard-cache.js'
import { activeLiveSql } from '../lib/live-merge-sql.js'
import { notArchivedSql, saoPauloInclusiveRangeSql } from '../lib/live-count-sql.js'
import { marcaFixoVigenciaSql } from '../lib/receita-marca-sql.js'
import { listarCustos } from '../services/custos-plano.js'
import {
  atualizarConfigFinanceiro, buscarConfigFinanceiro, calcularDre, calcularFluxoCaixa,
  consultarLancamentos, desfazerImposto, hojeSaoPaulo, pagarImposto, resolverPeriodoMeses,
} from '../services/financeiro-agregador.js'

const FINANCEIRO_RESUMO_CACHE_TTL_MS = Number(process.env.FINANCEIRO_RESUMO_CACHE_TTL_MS ?? 45_000)

// Filtros de GET /lancamentos e payloads de baixa/config (onda 2).
const lancamentosQuerySchema = z.object({
  natureza: z.enum(['receita', 'custo']).optional(),
  status: z.enum(['previsto', 'pendente', 'atrasado', 'parcial', 'pago']).optional(),
  grupo: z.string().trim().min(1).max(40).optional(),
  q: z.string().trim().max(120).optional(),
}).passthrough()

const baixaImpostoSchema = z.object({
  valor_pago: moneySchema.refine((v) => v > 0, 'valor_pago deve ser positivo').optional(),
  data_pagamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato: YYYY-MM-DD').optional(),
  observacao: z.string().trim().max(500).optional(),
}).strict()

const configSchema = z.object({
  aliquota_imposto_pct: z.coerce.number().min(0).max(100),
}).strict()

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// Erros de serviço (statusCode 4xx) viram resposta; o resto sobe para o error handler.
function responderErro(reply, error) {
  if (error?.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.message })
  throw error
}

const toNum = (v) => Number(v ?? 0)
const roundMoney = (v) => Math.round(toNum(v) * 100) / 100

/**
 * Competência canônica YYYY-MM-DD para juntar comissão (::date → string via pg-date-string)
 * com fixo mensal (timestamp → Date JS). Sem isso a chave `marca_id:mes` diverge
 * (`2026-09-01` vs `Tue Sep 01`) e marcas `fixo_ou_comissao` emitem duas linhas
 * vencedoras no mesmo mês — o DRE do front rejeita o payload.
 */
export function competenciaMesKey(mes) {
  if (mes == null || mes === '') return ''
  if (mes instanceof Date && !Number.isNaN(mes.getTime())) {
    return mes.toISOString().slice(0, 10)
  }
  const raw = String(mes).trim()
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : raw.slice(0, 10)
}

// Fixo mensal das marcas tipo='cliente': POR VIGÊNCIA (decisão do dono, SPEC v2) — todo
// mês entre o início e data_fim do contrato, com ou sem atividade, rateado por dias no
// mês de entrada/saída. FONTE ÚNICA em lib/receita-marca-sql.js (mesma das receitas):
// /resumo (soma) e /operacional (1 lançamento por marca/mês) — não duplicar.
// `meses_ativos` = contagem de meses (display); `fator_meses` = fração rateada (valor monetário).
// Params posicionais fixos: $1=startDate, $2=endDate, $3=tenant_id.
const marcaFixoMensalSql = marcaFixoVigenciaSql

// Vendas reprovadas NUNCA entram em soma financeira (mesmo predicado de lib/operacional.js).
const VENDA_NAO_REPROVADA = `COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'`

// Classificação fixa × variável dos totais do resultado operacional:
//   despesas_fixas     = fixo_apresentadora + custos manuais tipo aluguel/salario/energia/internet
//   despesas_variaveis = comissao_apresentadora + custos manuais tipo 'outros'
// (comissao_franquia e fixo_marca são ENTRADAS — receita da operação)
// Custos v2 (migration 164): também é fixo o recorrente e os grupos estrutural/prolabore.
const CUSTO_TIPOS_FIXOS = new Set(['aluguel', 'salario', 'energia', 'internet'])
const CUSTO_GRUPOS_FIXOS = new Set(['estrutural', 'prolabore'])
const custoManualFixo = (m) => CUSTO_TIPOS_FIXOS.has(m.tipo) || m.origem === 'recorrente' || CUSTO_GRUPOS_FIXOS.has(m.grupo)

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
            AND ${activeLiveSql('l')}
            AND ${notArchivedSql('l')}
            AND ${saoPauloInclusiveRangeSql('l.iniciado_em', '$1', '$2')}
        ),
        video_periodo AS (
          SELECT
            COALESCE(SUM(vr.gmv_atribuido), 0) AS gmv_videos,
            COALESCE(SUM(vr.pedidos_atribuidos), 0)::int AS pedidos_videos,
            COUNT(*)::int AS total_videos,
            COALESCE(SUM(CASE WHEN mc.id IS NOT NULL
                              THEN va.gmv * COALESCE(mc.comissao_franquia_pct, 0) / 100.0
                              ELSE va.comissao_franquia END), 0) AS comissao_franquia_videos
          FROM video_registros vr
          LEFT JOIN vendas_atribuidas va
            ON va.tenant_id = vr.tenant_id AND va.origem = 'video' AND va.origem_id = vr.id
           AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
          LEFT JOIN LATERAL (
            SELECT c.id, c.comissao_franquia_pct
              FROM marca_condicoes_comerciais c
             WHERE c.tenant_id = vr.tenant_id AND c.marca_id = vr.marca_id
               AND c.inicio_vigencia <= vr.data AND c.cancelled_at IS NULL
             ORDER BY c.inicio_vigencia DESC LIMIT 1
          ) mc ON true
          WHERE vr.tenant_id = $3::uuid
            AND vr.data >= $1::date
            AND vr.data <= $2::date
        ),
        -- Comissão de franquia VARIÁVEL por marca (gmv × pct), mesma fonte do live_periodo mas
        -- agrupada por marca resolvida — pra combinar com o fixo POR marca conforme tipo_cobranca.
        comissao_marca_raw AS (
          SELECT mc.marca_id,
                 date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo') AS mes,
                 COALESCE(SUM(${liveGmvSql('l')} * COALESCE(mc.comissao_franquia_pct, 0) / 100.0), 0) AS comissao
          FROM lives l
          ${marcaResolveLateralSql('$3')}
          WHERE l.tenant_id = $3::uuid
            AND l.status = 'encerrada'
            AND ${activeLiveSql('l')}
            AND ${notArchivedSql('l')}
            AND ${saoPauloInclusiveRangeSql('l.iniciado_em', '$1', '$2')}
            AND mc.id IS NOT NULL
          GROUP BY mc.marca_id, date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')
          UNION ALL
          SELECT va.marca_id,
                 date_trunc('month', va.data::timestamp) AS mes,
                 COALESCE(SUM(CASE WHEN vc.id IS NOT NULL
                                   THEN va.gmv * COALESCE(vc.comissao_franquia_pct, 0) / 100.0
                                   ELSE va.comissao_franquia END), 0) AS comissao
            FROM vendas_atribuidas va
            LEFT JOIN LATERAL (
              SELECT c.id, c.comissao_franquia_pct
                FROM marca_condicoes_comerciais c
               WHERE c.tenant_id = va.tenant_id AND c.marca_id = va.marca_id
                 AND c.inicio_vigencia <= va.data AND c.cancelled_at IS NULL
               ORDER BY c.inicio_vigencia DESC LIMIT 1
            ) vc ON true
           WHERE va.tenant_id = $3::uuid AND va.origem = 'video'
             AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
             AND va.data >= $1::date AND va.data <= $2::date
           GROUP BY va.marca_id, date_trunc('month', va.data::timestamp)
        ),
        comissao_marca AS (
          SELECT marca_id, mes, SUM(comissao) AS comissao
            FROM comissao_marca_raw
           GROUP BY marca_id, mes
        ),
        -- Fixo mensal das marcas tipo='cliente' por vigência (valor × fator de rateio).
        -- Fonte compartilhada marcaFixoMensalSql() = marcaFixoVigenciaSql — mesma do /operacional e das receitas.
        fixo_marca AS (
          SELECT mf.marca_id, mf.mes, mf.tipo_cobranca,
                 (mf.valor_fixo_minimo * mf.fator_meses) AS fixo
          FROM (${marcaFixoMensalSql()}) mf
        ),
        -- Entrada POR marca: junta comissão variável e fixo mensal; tipo_cobranca decide se soma
        -- (fixo_mais_comissao) ou pega o maior (fixo_ou_comissao). Default preserva o aditivo.
        entrada_marca AS (
          SELECT COALESCE(cm.marca_id, fm.marca_id) AS marca_id,
                 COALESCE(cm.mes, fm.mes) AS mes,
                 COALESCE(cm.comissao, 0) AS comissao,
                 COALESCE(fm.fixo, 0) AS fixo,
                 COALESCE(fm.tipo_cobranca, mk.tipo_cobranca, 'fixo_mais_comissao') AS tipo_cobranca
          FROM comissao_marca cm
          FULL OUTER JOIN fixo_marca fm ON fm.marca_id = cm.marca_id AND fm.mes = cm.mes
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
        ),
        parcelas_competencia AS (
          SELECT mes,
                 COALESCE(SUM(fixo), 0) AS fixo,
                 COALESCE(SUM(comissao), 0) AS comissao,
                 COALESCE(SUM(
                   CASE WHEN tipo_cobranca = 'fixo_ou_comissao' THEN GREATEST(fixo, comissao)
                        ELSE fixo + comissao END
                 ), 0) AS receita
            FROM entrada_marca
           GROUP BY mes
           ORDER BY mes
        )
        SELECT lp.gmv_lives, lp.pedidos_lives, lp.total_lives,
               lp.comissao_franquia_lives, lp.comissao_configurada, lp.comissao_faltante_count,
               vp.gmv_videos, vp.pedidos_videos, vp.total_videos,
               vp.comissao_franquia_videos,
               tm.fixo_mensal_total, tm.receita_combinada,
               COALESCE((SELECT json_agg(json_build_object(
                 'competencia', pc.mes::date,
                 'fixo', pc.fixo,
                 'comissao', pc.comissao,
                 'receita', pc.receita
               ) ORDER BY pc.mes) FROM parcelas_competencia pc), '[]'::json) AS parcelas_competencia
        FROM live_periodo lp, video_periodo vp, totais_marca tm
      `, [startDate, endDate, tenant_id])

      const r = result.rows[0]
      const fat_bruto = toNum(r.gmv_lives) + toNum(r.gmv_videos)
      // receita_liquida = combinação POR marca de (comissão variável, fixo mensal por vigência)
      // conforme tipo_cobranca: fixo_mais_comissao soma; fixo_ou_comissao pega o maior.
      const receita_liquida = toNum(r.receita_combinada)
      return {
        visao,
        fat_bruto,
        gmv_total: fat_bruto,
        gmv_lives: toNum(r.gmv_lives),
        gmv_videos: toNum(r.gmv_videos),
        pedidos: toNum(r.pedidos_lives) + toNum(r.pedidos_videos),
        total_lives: toNum(r.total_lives),
        total_videos: toNum(r.total_videos),
        comissao_franquia_lives: toNum(r.comissao_franquia_lives),
        comissao_franquia_videos: toNum(r.comissao_franquia_videos),
        receita_liquida,
        fixo_mensal: toNum(r.fixo_mensal_total),
        comissao_configurada: toNum(r.comissao_configurada),
        comissao_faltante_count: toNum(r.comissao_faltante_count),
        periodo: startDate,
        inicio: startDate,
        fim: endDate,
        parcelas_competencia: Array.isArray(r.parcelas_competencia) ? r.parcelas_competencia : [],
      }
      }),
    })
    // DRE (previsto × realizado) fora do cache: baixas precisam aparecer na hora.
    const dre = await app.withTenant(tenant_id, (db) => calcularDre(db, {
      tenantId: tenant_id, inicio: startDate.slice(0, 7), fim: endDate.slice(0, 7), hoje: hojeSaoPaulo(),
    }))
    // Legado: total_custos = custos manuais previstos da competência (sem apresentadoras/imposto);
    // fat_liquido = receita_liquida − total_custos (piso 0). O resultado completo está em dre.totais.
    const total_custos = dre.totais.custos.previsto
    const body = {
      ...value,
      total_custos,
      fat_liquido: Math.max(0, roundMoney(value.receita_liquida - total_custos)),
      aliquota_imposto_pct: dre.aliquota,
      meses: dre.meses,
      totais: dre.totais,
    }
    setCacheControl(reply, state, startedAt)
    return body
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
          SELECT COALESCE(l.cliente_id, marca_cliente.cliente_id) AS cliente_id, l.marca_id,
                 ${liveGmvSql('l')} AS gmv,
                 -- comissão de franquia inline (gmv × pct da marca resolvida), não da coluna
                 -- pré-calculada/estagnada do motor — mantém o breakdown por cliente coerente
                 -- com /resumo e com a aba Comissões.
                 ${liveGmvSql('l')} * COALESCE(mc.comissao_franquia_pct, 0) / 100.0 AS comissao_franquia,
                 1 AS is_live, 0 AS is_video
          FROM lives l
          ${marcaResolveLateralSql('$3')}
          LEFT JOIN marcas marca_cliente ON marca_cliente.id = l.marca_id
            AND marca_cliente.tenant_id = l.tenant_id
          WHERE l.tenant_id = $3::uuid
            AND l.status = 'encerrada'
            AND ${activeLiveSql('l')}
            AND ${notArchivedSql('l')}
            AND ${saoPauloInclusiveRangeSql('l.iniciado_em', '$1', '$2')}
          UNION ALL
          SELECT m.cliente_id, vr.marca_id,
                 vr.gmv_atribuido AS gmv,
                 vr.gmv_atribuido * COALESCE((
                   SELECT c.comissao_franquia_pct
                     FROM marca_condicoes_comerciais c
                    WHERE c.tenant_id = vr.tenant_id AND c.marca_id = vr.marca_id
                      AND c.inicio_vigencia <= vr.data AND c.cancelled_at IS NULL
                    ORDER BY c.inicio_vigencia DESC LIMIT 1
                 ), m.comissao_franquia_pct, 0) / 100.0 AS comissao_franquia,
                 0 AS is_live, 1 AS is_video
          FROM video_registros vr
          JOIN marcas m ON m.id = vr.marca_id AND m.tenant_id = vr.tenant_id
          WHERE vr.tenant_id = $3::uuid
            AND vr.data >= $1::date
            AND vr.data <= $2::date
        ),
        agg AS (
          SELECT cliente_id,
                 CASE WHEN cliente_id IS NULL THEN marca_id END AS marca_id,
                 COALESCE(SUM(gmv), 0) AS total,
                 COALESCE(SUM(comissao_franquia), 0) AS receita_liquida,
                 COALESCE(SUM(is_live), 0)::int AS lives_mes,
                 COALESCE(SUM(is_video), 0)::int AS videos_mes
          FROM base
          GROUP BY cliente_id, CASE WHEN cliente_id IS NULL THEN marca_id END
        )
        SELECT
          COALESCE(agg.cliente_id, agg.marca_id) AS id,
          COALESCE(cl.nome, m.nome, 'Sem marca') AS nome,
          COALESCE(cl.nicho, m.tipo) AS nicho,
          CASE WHEN cl.id IS NOT NULL THEN 'cliente_ecommerce' ELSE COALESCE(m.tipo, 'sem_marca') END AS tipo_operacional,
          CASE
            WHEN cl.id IS NOT NULL THEN 'cliente'
            WHEN m.id IS NOT NULL THEN 'marca'
            ELSE 'sem_marca'
          END AS tipo_entidade,
          cl.id AS cliente_id,
          m.id AS marca_id,
          agg.total, agg.receita_liquida, agg.lives_mes, agg.videos_mes
        FROM agg
        LEFT JOIN clientes cl ON cl.id = agg.cliente_id AND cl.tenant_id = $3::uuid
        LEFT JOIN marcas m ON m.id = agg.marca_id AND m.tenant_id = $3::uuid
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

  // GET /v1/financeiro/fluxo-caixa?mes=YYYY-MM[&saldo_inicial=]  (legado: inicio/fim ou mes+ano → 1º mês)
  // Linhas por data de vencimento nas faixas 5/10/15/20/25/30 (+ 'cartao'), previsto × realizado,
  // acumulado a partir de saldo_inicial, serie_anual jan–dez. Mantém entradas/saidas/items legados.
  app.get('/v1/financeiro/fluxo-caixa', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request, reply) => {
    const { tenant_id } = request.user
    const hoje = hojeSaoPaulo()
    let mes
    try {
      mes = resolverPeriodoMeses(request.query ?? {}, hoje).inicio
    } catch (error) {
      return responderErro(reply, error)
    }
    const saldoRaw = request.query?.saldo_inicial
    const saldoInicial = saldoRaw == null || saldoRaw === '' ? 0 : Number(saldoRaw)
    if (!Number.isFinite(saldoInicial)) return reply.code(400).send({ error: 'saldo_inicial inválido' })
    try {
      return await app.withTenant(tenant_id, (db) => calcularFluxoCaixa(db, { tenantId: tenant_id, mes, saldoInicial, hoje }))
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  // GET /v1/financeiro/operacional?inicio=YYYY-MM&fim=YYYY-MM (default: mês corrente SP)
  // Resultado operacional automático: entradas (comissão de franquia + fixo de marca) −
  // saídas (fixo/comissão de apresentadoras + custos manuais), com memória de cálculo
  // por lançamento. Lançamentos AGREGADOS por entidade (marca/apresentadora), não por venda.
  app.get('/v1/financeiro/operacional', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id } = request.user
    const { startDate, endDate } = resolveMonthRange(request.query)
    const round2 = roundMoney
    const pctMedio = (valor, gmv) => (gmv > 0 ? round2((valor / gmv) * 100) : 0)

    return app.withTenant(tenant_id, async (db) => {
      // ENTRADA: comissão de franquia por marca (vendas não-reprovadas do período)
      const comissaoFranquia = await db.query(`
        -- SUM(va.comissao_franquia) permanece no inventário como fallback legado;
        -- condições temporais substituem esse valor quando existe snapshot.
        -- O GMV da live segue liveGmvSql; vídeo continua na coluna da venda.
        SELECT va.marca_id, m.nome AS marca_nome,
               COALESCE(vc.tipo_cobranca, m.tipo_cobranca, 'fixo_mais_comissao') AS tipo_cobranca,
               date_trunc('month', va.data::timestamp)::date AS mes,
               COALESCE(SUM(CASE WHEN vc.id IS NOT NULL
                                 THEN (${officialLineGmvExpr('va')}) * COALESCE(vc.comissao_franquia_pct, 0) / 100.0
                                 ELSE (${officialLineCommissionExpr('va', 'comissao_franquia')}) END), 0) AS valor,
               COALESCE(SUM(${officialLineGmvExpr('va')}), 0) AS gmv,
               COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'live')::int AS lives
        FROM vendas_atribuidas va
        JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
        LEFT JOIN LATERAL (
          SELECT c.id, c.comissao_franquia_pct, c.tipo_cobranca
            FROM marca_condicoes_comerciais c
           WHERE c.tenant_id = va.tenant_id AND c.marca_id = va.marca_id
             AND c.inicio_vigencia <= va.data AND c.cancelled_at IS NULL
           ORDER BY c.inicio_vigencia DESC LIMIT 1
        ) vc ON true
        WHERE va.tenant_id = $3::uuid
          AND va.data >= $1::date AND va.data <= $2::date
          AND ${VENDA_NAO_REPROVADA}
        GROUP BY va.marca_id, m.nome, vc.tipo_cobranca, m.tipo_cobranca, date_trunc('month', va.data::timestamp)::date
        HAVING COALESCE(SUM(CASE WHEN vc.id IS NOT NULL
                                 THEN (${officialLineGmvExpr('va')}) * COALESCE(vc.comissao_franquia_pct, 0) / 100.0
                                 ELSE (${officialLineCommissionExpr('va', 'comissao_franquia')}) END), 0) <> 0
        ORDER BY valor DESC
      `, [startDate, endDate, tenant_id])

      // ENTRADA: fixo mensal por marca tipo=cliente por vigência (mesma fonte do /resumo).
      // `mes` precisa sair no SELECT: sem ele a junção com comissão usa chave `marca_id:`
      // vazia e marcas fixo_ou_comissao geram duas linhas vencedoras no mesmo mês.
      const fixoMarcas = await db.query(`
        SELECT mf.marca_id, mf.marca_nome, mf.valor_fixo_minimo, mf.tipo_cobranca,
               mf.meses_ativos, mf.fator_meses, mf.mes
        FROM (${marcaFixoMensalSql()}) mf
        WHERE mf.valor_fixo_minimo > 0
        ORDER BY mf.valor_fixo_minimo DESC
      `, [startDate, endDate, tenant_id])

      // SAÍDA: comissão por apresentadora (vendas não-reprovadas do período)
      const comissaoApresentadoras = await db.query(`
        -- SUM(va.comissao_apresentadora) lida na mesma ordem de liveGmvSql
        SELECT va.apresentadora_id, a.nome,
               COALESCE(SUM(${officialLineCommissionExpr('va', 'comissao_apresentadora')}), 0) AS valor,
               COALESCE(SUM(${officialLineGmvExpr('va')}), 0) AS gmv
        FROM vendas_atribuidas va
        JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
        WHERE va.tenant_id = $3::uuid
          AND va.data >= $1::date AND va.data <= $2::date
          AND ${VENDA_NAO_REPROVADA}
        GROUP BY va.apresentadora_id, a.nome
        HAVING COALESCE(SUM(${officialLineCommissionExpr('va', 'comissao_apresentadora')}), 0) <> 0
        ORDER BY valor DESC
      `, [startDate, endDate, tenant_id])

      // SAÍDA: fixo mensal (com cap padrão) das apresentadoras ativas não-arquivadas,
      // rateado por dias de contrato (data_inicio/data_fim, migration 041), SOMADO por mês do
      // range [$1,$3]. Saiu dia 15 → metade naquele mês; mês fora do contrato → 0; datas NULL →
      // fixo cheio por mês. Consistente com o fator_meses da marca. Single-mês (default) = 1 parcela.
      // O fixo entra DENTRO do SUM por mês (migration 137): cada parcela usa o salário
      // vigente no último dia daquele mês, não o valor de cadastro de hoje. Antes o
      // fixo multiplicava a soma inteira, então um reajuste reescrevia retroativamente
      // todos os meses do intervalo — inclusive competências já fechadas.
      const fixoApresentadoras = await db.query(`
        SELECT a.id AS apresentadora_id, a.nome,
               ROUND(COALESCE((
                 SELECT SUM(
                   (${presenterFixedAtSql('a', "((gs.mes + interval '1 month' - interval '1 day')::date)")})
                   * ${prorateFatorSql('gs.mes', 'a.data_inicio', 'a.data_fim')}
                 )
                 FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $3::date), interval '1 month') gs(mes)
               ), 0), 2) AS valor
        FROM apresentadoras a
        WHERE a.tenant_id = $2::uuid AND a.ativo IS TRUE AND COALESCE(a.arquivada, false) = false
        ORDER BY valor DESC, a.nome ASC
      `, [startDate, tenant_id, endDate])

      // SAÍDA: custos manuais da competência (pontuais, parcelas e recorrentes — inclusive os
      // virtuais ainda não materializados) via listarCustos, fonte única do módulo de custos.
      // Imposto materializado (tipo 'imposto') não é custo manual e fica fora deste contrato.
      const custosManuais = (await listarCustos(db, {
        tenantId: tenant_id, inicio: startDate.slice(0, 7), fim: endDate.slice(0, 7), hoje: hojeSaoPaulo(),
      })).filter((c) => c.tipo !== 'imposto')

      // SAÍDA: adicionais de apresentadora lançados manualmente no fechamento. Não são
      // custos manuais e não entram em comissão: cada linha é descontada exatamente uma vez.
      const adicionaisApresentadoras = await db.query(`
        SELECT ara.id, ara.apresentadora_id, a.nome, ara.tipo, ara.descricao,
               ara.data_referencia, ara.valor
        FROM apresentadora_remuneracao_adicionais ara
        JOIN apresentadoras a ON a.id = ara.apresentadora_id AND a.tenant_id = ara.tenant_id
        WHERE ara.tenant_id = $3::uuid
          AND ara.competencia >= date_trunc('month', $1::date)::date
          AND ara.competencia <= date_trunc('month', $2::date)::date
          AND ara.cancelado_em IS NULL
        ORDER BY ara.valor DESC, ara.criado_em ASC
      `, [startDate, endDate, tenant_id])

      // Lives encerradas com GMV e sem linha em vendas_atribuidas. Não entram nas
      // somas: comissão 0 confirmada já tem linha e não conta aqui.
      const semApuracao = await db.query(`
        SELECT COUNT(*)::int AS lives_sem_apuracao
          FROM lives l
         WHERE l.tenant_id = $3::uuid
           AND l.status = 'encerrada'
           AND ${activeLiveSql('l')}
           AND ${notArchivedSql('l')}
           AND ${saoPauloInclusiveRangeSql('l.iniciado_em', '$1', '$2')}
           AND ${liveGmvSql('l')} > 0
           AND NOT EXISTS (
             SELECT 1 FROM vendas_atribuidas va
              WHERE va.tenant_id = l.tenant_id
                AND va.origem = 'live'
                AND va.origem_id = l.id
           )
      `, [startDate, endDate, tenant_id])
      const livesSemApuracao = Number(semApuracao.rows[0]?.lives_sem_apuracao ?? 0)

      // Junta comissão variável + fixo mensal POR marca. tipo_cobranca decide a composição da
      // ENTRADAS (mesma regra de combinarEntradaMarca): 'fixo_mais_comissao' soma as duas linhas;
      // 'fixo_ou_comissao' entra só a maior (uma linha vencedora) → total = GREATEST(fixo, comissao).
      const marcaEntradas = new Map()
      for (const r of comissaoFranquia.rows) {
        const mes = competenciaMesKey(r.mes)
        const key = `${r.marca_id}:${mes}`
        marcaEntradas.set(key, {
          marca_id: r.marca_id,
          marca_nome: r.marca_nome,
          tipo: r.tipo_cobranca || 'fixo_mais_comissao',
          comissao: round2(r.valor), gmv: round2(r.gmv), lives: toNum(r.lives),
          mes, fixo: 0, meses_ativos: 0,
        })
      }
      for (const r of fixoMarcas.rows) {
        // valor monetário rateado por dias de contrato (fator_meses); meses_ativos fica só p/ display.
        const fixo = round2(toNum(r.valor_fixo_minimo) * toNum(r.fator_meses))
        const mes = competenciaMesKey(r.mes)
        const key = `${r.marca_id}:${mes}`
        const cur = marcaEntradas.get(key)
        if (cur) {
          cur.fixo = round2(cur.fixo + fixo)
          cur.meses_ativos += toNum(r.meses_ativos)
          cur.tipo = r.tipo_cobranca || cur.tipo
        } else {
          marcaEntradas.set(key, {
            marca_id: r.marca_id,
            marca_nome: r.marca_nome,
            tipo: r.tipo_cobranca || 'fixo_mais_comissao',
            comissao: 0, gmv: 0, lives: 0,
            mes, fixo, meses_ativos: toNum(r.meses_ativos),
          })
        }
      }

      const entradas = []
      for (const m of marcaEntradas.values()) {
        const competenciaMemoria = m.mes ? { competencia: m.mes } : {}
        const linhaComissao = () => ({
          categoria: 'comissao_franquia',
          descricao: `Comissão de franquia — ${m.marca_nome}`,
          valor: round2(m.comissao),
          memoria: { marca_id: m.marca_id, marca_nome: m.marca_nome, ...competenciaMemoria, gmv: m.gmv, lives: m.lives, pct_medio: pctMedio(m.comissao, m.gmv) },
        })
        const linhaFixo = (criterio) => ({
          categoria: 'fixo_marca',
          descricao: `Fixo mensal — ${m.marca_nome}`,
          valor: round2(m.fixo),
          memoria: { marca_id: m.marca_id, marca_nome: m.marca_nome, ...competenciaMemoria, criterio, meses_ativos: m.meses_ativos },
        })
        if (m.tipo === 'fixo_ou_comissao') {
          // entra só a maior — uma linha; memória registra o que foi comparado
          if (m.fixo >= m.comissao) {
            if (m.fixo > 0) entradas.push({
              ...linhaFixo('fixo_ou_comissao_venceu_fixo'),
              memoria: {
                ...linhaFixo('fixo_ou_comissao_venceu_fixo').memoria,
                comissao_comparada: round2(m.comissao),
              },
            })
          } else {
            entradas.push({
              ...linhaComissao(),
              memoria: {
                ...linhaComissao().memoria,
                criterio: 'fixo_ou_comissao_venceu_comissao',
                fixo_comparado: round2(m.fixo),
              },
            })
          }
        } else {
          if (m.comissao > 0) entradas.push(linhaComissao())
          if (m.fixo > 0) entradas.push(linhaFixo('vigencia'))
        }
      }
      entradas.sort((a, b) => b.valor - a.valor)

      // Valores já em centavos estáveis (round2): o DRE do front reconcilia Σ(linhas)
      // com totais reportados e rejeita divergência de 1 centavo.
      const saidas = [
        ...fixoApresentadoras.rows.map((r) => ({
          categoria: 'fixo_apresentadora',
          descricao: `Fixo mensal — ${r.nome}`,
          valor: round2(r.valor),
          memoria: { apresentadora_id: r.apresentadora_id, nome: r.nome, criterio: 'fixo_mensal' },
        })),
        ...comissaoApresentadoras.rows.map((r) => ({
          categoria: 'comissao_apresentadora',
          descricao: `Comissão — ${r.nome}`,
          valor: round2(r.valor),
          memoria: {
            apresentadora_id: r.apresentadora_id,
            nome: r.nome,
            gmv_atribuido: round2(r.gmv),
            pct_medio: pctMedio(toNum(r.valor), toNum(r.gmv)),
          },
        })),
        ...adicionaisApresentadoras.rows.map((r) => ({
          categoria: 'adicional_apresentadora',
          descricao: `${r.tipo === 'fim_de_semana' ? 'Diária fim de semana' : 'Bonificação'} — ${r.nome}: ${r.descricao}`,
          valor: round2(r.valor),
          memoria: {
            adicional_id: r.id,
            apresentadora_id: r.apresentadora_id,
            nome: r.nome,
            tipo: r.tipo,
            data_referencia: r.data_referencia,
          },
        })),
        ...custosManuais.map((c) => ({
          categoria: 'custo_manual',
          descricao: c.descricao,
          valor: round2(c.valor_previsto),
          memoria: {
            custo_id: c.id, tipo: c.tipo, grupo: c.grupo ?? null, origem: c.origem,
            competencia: c.competencia, data_vencimento: c.data_vencimento, status: c.status,
          },
        })),
      ]

      const isFixa = (l) => l.categoria === 'fixo_apresentadora'
        || (l.categoria === 'custo_manual' && custoManualFixo(l.memoria))
      const totalEntradas = round2(entradas.reduce((s, l) => s + l.valor, 0))
      const despesasFixas = round2(saidas.reduce((s, l) => s + (isFixa(l) ? l.valor : 0), 0))
      const despesasVariaveis = round2(saidas.reduce((s, l) => s + (isFixa(l) ? 0 : l.valor), 0))

      return {
        periodo: { inicio: startDate, fim: endDate },
        entradas,
        saidas,
        totais: {
          entradas: totalEntradas,
          despesas_fixas: despesasFixas,
          despesas_variaveis: despesasVariaveis,
          resultado: round2(totalEntradas - despesasFixas - despesasVariaveis),
        },
        // Pendência de schema: supervisor e demais integrantes da equipe não têm
        // remuneração cadastrada — lançar manualmente em custos (tipo 'salario').
        pendencias: ['equipe_sem_remuneracao_no_schema'],
        lives_sem_apuracao: livesSemApuracao,
      }
    })
  })

  // ─── Onda 2: lançamentos unificados, imposto e config ──────────────────────

  // GET /v1/financeiro/lancamentos?inicio=YYYY-MM&fim=YYYY-MM&natureza=&status=&grupo=&q=
  // Receitas (comercial) + custos + pagamentos de apresentadoras + imposto, status derivado.
  app.get('/v1/financeiro/lancamentos', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request, reply) => {
    const { tenant_id } = request.user
    const hoje = hojeSaoPaulo()
    const parsed = lancamentosQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    try {
      const { inicio, fim } = resolverPeriodoMeses(request.query ?? {}, hoje)
      const { natureza, status, grupo, q } = parsed.data
      return await app.withTenant(tenant_id, (db) => consultarLancamentos(db, {
        tenantId: tenant_id, inicio, fim, hoje, filtros: { natureza, status, grupo, q },
      }))
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  // PATCH /v1/financeiro/impostos/:mes/pagar {valor_pago?, data_pagamento?, observacao?}
  app.patch('/v1/financeiro/impostos/:mes/pagar', { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const { mes } = request.params
    if (!MES_RE.test(mes)) return reply.code(400).send({ error: 'mes deve ter o formato YYYY-MM' })
    const parsed = baixaImpostoSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    try {
      const item = await app.withTenant(tenant_id, (db) => pagarImposto(db, {
        tenantId: tenant_id, mes, valorPago: parsed.data.valor_pago,
        dataPagamento: parsed.data.data_pagamento, observacao: parsed.data.observacao, hoje: hojeSaoPaulo(),
      }))
      invalidateTenant(tenant_id)
      app.audit?.log?.(request, { action: 'financeiro.imposto_pagar', entity_type: 'imposto', entity_id: item.custo_id, metadata: { mes, ...parsed.data } })
        ?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
      return item
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  // PATCH /v1/financeiro/impostos/:mes/desfazer
  app.patch('/v1/financeiro/impostos/:mes/desfazer', { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const { mes } = request.params
    if (!MES_RE.test(mes)) return reply.code(400).send({ error: 'mes deve ter o formato YYYY-MM' })
    const { tenant_id } = request.user
    try {
      const item = await app.withTenant(tenant_id, (db) => desfazerImposto(db, { tenantId: tenant_id, mes, hoje: hojeSaoPaulo() }))
      invalidateTenant(tenant_id)
      app.audit?.log?.(request, { action: 'financeiro.imposto_desfazer', entity_type: 'imposto', entity_id: null, metadata: { mes } })
        ?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
      return item
    } catch (error) {
      return responderErro(reply, error)
    }
  })

  // GET/PATCH /v1/financeiro/config {aliquota_imposto_pct}
  app.get('/v1/financeiro/config', { preHandler: app.requirePapel(READ_FINANCEIRO) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, (db) => buscarConfigFinanceiro(db, tenant_id))
  })

  app.patch('/v1/financeiro/config', { preHandler: app.requirePapel(WRITE_FINANCEIRO) }, async (request, reply) => {
    const parsed = configSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'aliquota_imposto_pct deve ser um número entre 0 e 100' })
    const { tenant_id } = request.user
    const config = await app.withTenant(tenant_id, (db) => atualizarConfigFinanceiro(db, tenant_id, parsed.data))
    invalidateTenant(tenant_id)
    app.audit?.log?.(request, { action: 'financeiro.config_update', entity_type: 'tenant', entity_id: tenant_id, metadata: parsed.data })
      ?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
    return config
  })
}
