import { performance } from 'node:perf_hooks'
import { READ_LEADS } from '../config/role_groups.js'
import { buildCacheKey, setCacheControl, withCache } from '../lib/dashboard-cache.js'

// TTL longo: a invalidação por evento (hook global em app.js, disparado por
// qualquer escrita — inclusive webhooks de lead) é quem mantém o CRM fresco.
const CRM_CACHE_TTL_MS = Number(process.env.CRM_CACHE_TTL_MS ?? 300_000)

const CRM_ETAPAS = [
  'lead_novo',
  'contato_iniciado',
  'reuniao_agendada',
  'proposta_enviada',
  'em_negociacao',
  'aguardando_assinatura',
  'ganho',
  'perdido',
]

function toNumber(value) {
  return Number(value ?? 0)
}

function mapMetricRow(row = {}) {
  return {
    total_leads: toNumber(row.total_leads),
    valor_pipeline: toNumber(row.valor_pipeline),
    valor_estimado: toNumber(row.valor_estimado),
    ganhos: toNumber(row.ganhos),
    perdidos: toNumber(row.perdidos),
  }
}

export async function crmRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_LEADS)]

  app.get('/v1/crm/summary', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user

    // Cache orientado a evento: as 4 agregações varrem os leads do tenant.
    // Invalidação vem do hook global (app.js) em qualquer escrita — inclusive
    // dos webhooks de lead (Make/bio). TTL só como rede de segurança.
    const startedAt = performance.now()
    const { value, state } = await withCache({
      namespace: 'crm:summary',
      key: buildCacheKey(tenant_id),
      ttlMs: CRM_CACHE_TTL_MS,
      // tenantParallel (não withTenant): as 4 agregações estão num Promise.all —
      // num client único o driver pg as enfileira e elas viram 4 idas sequenciais
      // ao banco. Aqui cada uma usa sua própria conexão: o Promise.all custa ~1 ida.
      computeFn: () => (async (db) => {
      const baseWhere = `
        franqueadora_id = $1
        AND status != 'expirado'
        AND COALESCE(crm_etapa, 'lead_novo') = ANY($2::text[])
      `
      const params = [tenant_id, CRM_ETAPAS]

      const [totalsQ, pipelineQ, origemQ, alertasQ] = await Promise.all([
        db.query(
          `SELECT
             COUNT(*)::int AS total_leads,
             COALESCE(SUM(valor_oportunidade) FILTER (
               WHERE COALESCE(crm_etapa, 'lead_novo') NOT IN ('ganho', 'perdido')
             ), 0) AS valor_pipeline,
             COALESCE(SUM(valor_oportunidade), 0) AS valor_estimado,
             COUNT(*) FILTER (WHERE crm_etapa = 'ganho')::int AS ganhos,
             COUNT(*) FILTER (WHERE crm_etapa = 'perdido')::int AS perdidos
           FROM leads
           WHERE ${baseWhere}`,
          params,
        ),
        db.query(
          `SELECT
             COALESCE(crm_etapa, 'lead_novo') AS etapa,
             COUNT(*)::int AS total,
             COALESCE(SUM(valor_oportunidade), 0) AS valor
           FROM leads
           WHERE ${baseWhere}
           GROUP BY crm_etapa
           ORDER BY array_position($2::text[], COALESCE(crm_etapa, 'lead_novo'))`,
          params,
        ),
        db.query(
          `SELECT
             COALESCE(NULLIF(origem, ''), 'Sem origem') AS origem,
             COUNT(*)::int AS total,
             COALESCE(SUM(valor_oportunidade), 0) AS valor
           FROM leads
           WHERE ${baseWhere}
           GROUP BY COALESCE(NULLIF(origem, ''), 'Sem origem')
           ORDER BY total DESC, origem ASC`,
          params,
        ),
        db.query(
          `SELECT
             COUNT(*) FILTER (
               WHERE COALESCE(crm_etapa, 'lead_novo') NOT IN ('ganho', 'perdido')
                 AND atualizado_em < NOW() - interval '7 days'
             )::int AS leads_parados,
             COUNT(*) FILTER (
               WHERE COALESCE(NULLIF(responsavel_nome, ''), '') = ''
             )::int AS sem_responsavel,
             COUNT(*) FILTER (
               WHERE COALESCE(NULLIF(contato_email, ''), '') = ''
                 AND COALESCE(NULLIF(contato_whatsapp, ''), '') = ''
             )::int AS sem_contato,
             COUNT(*) FILTER (WHERE crm_etapa = 'aguardando_assinatura')::int AS aguardando_assinatura
           FROM leads
           WHERE ${baseWhere}`,
          params,
        ),
      ])

      const totals = mapMetricRow(totalsQ.rows[0])
      return {
        summary: {
          total_leads: totals.total_leads,
          valor_estimado: totals.valor_estimado,
          ganhos: totals.ganhos,
          perdidos: totals.perdidos,
        },
        totals,
        pipeline: pipelineQ.rows.map((row) => ({
          etapa: row.etapa,
          total: toNumber(row.total),
          valor: toNumber(row.valor),
        })),
        origem: origemQ.rows.map((row) => ({
          origem: row.origem,
          total: toNumber(row.total),
          valor: toNumber(row.valor),
        })),
        alertas: {
          leads_parados: toNumber(alertasQ.rows[0]?.leads_parados),
          sem_responsavel: toNumber(alertasQ.rows[0]?.sem_responsavel),
          sem_contato: toNumber(alertasQ.rows[0]?.sem_contato),
          aguardando_assinatura: toNumber(alertasQ.rows[0]?.aguardando_assinatura),
        },
      }
      })(app.tenantParallel(tenant_id)),
    })
    setCacheControl(reply, state, startedAt)
    return value
  })
}
