import { activeLiveSql } from '../lib/live-merge-sql.js'
import { notArchivedSql } from '../lib/live-count-sql.js'
import { liveGmvSql, liveOrdersSql, liveHoursSql, apresentadoraHorasSql, apresentadoraHorasPresencaSql } from '../lib/metric-sql.js'

const TZ = 'America/Sao_Paulo'
const n = value => Number(value ?? 0)
const round = value => Math.round((value + Number.EPSILON) * 100) / 100

// Uma linha por transmissão: a lista de participantes não multiplica GMV/horas da unidade.
// Vídeos seguem a régua de vendas atribuídas do diário/ranking, não o caixa legado.
export const MCP_FACTS_SQL = `
  WITH live_facts AS (
    SELECT l.id, 'live'::text AS origem, (l.iniciado_em AT TIME ZONE '${TZ}')::date::text AS dia,
      l.iniciado_em, l.encerrado_em, l.status, l.marca_id, m.nome AS marca_nome,
      l.cabine_id, c.numero::text AS cabine_nome,
      ${liveGmvSql()} AS gmv, ${liveOrdersSql()} AS pedidos,
      (l.ads_gmv IS NOT NULL OR l.manual_gmv IS NOT NULL OR l.fat_gerado IS NOT NULL) AS gmv_registrado,
      CASE WHEN COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
        THEN ${liveHoursSql()} ELSE 0 END AS horas,
      COALESCE(part.participantes, '[]'::jsonb) AS participantes
    FROM lives l
    LEFT JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
    LEFT JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
    LEFT JOIN apresentadoras principal ON principal.user_id = l.apresentador_id AND principal.tenant_id = l.tenant_id
    LEFT JOIN agenda_eventos ae ON ae.id = l.agenda_evento_id AND ae.tenant_id = l.tenant_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', ap_v2.apresentadora_id, 'nome', a.nome, 'papel', ap_v2.papel,
        'gmv', COALESCE(ap_v2.gmv_rateado,
          ${liveGmvSql()} * ap_v2.percentual_rateio / 100.0,
          CASE WHEN ap_v2.papel = 'principal' THEN ${liveGmvSql()} ELSE 0 END),
        'pedidos', COALESCE(venda.pedidos, CASE WHEN ap_v2.papel = 'principal' THEN ${liveOrdersSql()} ELSE 0 END),
        'horas_produtividade', CASE WHEN COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
          THEN ${apresentadoraHorasSql()} ELSE 0 END,
        'horas_presenca', ${apresentadoraHorasPresencaSql()},
        'presenca_estimada', COALESCE(ap_v2.segundos_rateio, 0) <= 0,
        'percentual_rateio', ap_v2.percentual_rateio
      ) ORDER BY a.nome) AS participantes
      FROM (
        SELECT lav.apresentadora_id, lav.gmv_rateado, lav.segundos_rateio, lav.percentual_rateio, lav.papel
        FROM live_apresentadoras_v2 lav WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
        UNION ALL
        SELECT principal.id, NULL::numeric, NULL::int, NULL::numeric, 'principal'
        WHERE NOT EXISTS (SELECT 1 FROM live_apresentadoras_v2 lav WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id)
          AND principal.id IS NOT NULL
        UNION ALL
        -- O legado comprova presença, mas não autoriza atribuir vendas ao apoio.
        SELECT DISTINCT a1.id, 0::numeric, NULL::int, 0::numeric, 'apoio'
        FROM live_apresentadores la JOIN apresentadoras a1 ON a1.user_id = la.apresentador_id AND a1.tenant_id = l.tenant_id
        WHERE la.live_id = l.id AND la.tenant_id = l.tenant_id
          AND a1.id IS DISTINCT FROM COALESCE(ae.apresentadora_id, principal.id)
          AND NOT EXISTS (SELECT 1 FROM live_apresentadoras_v2 lav WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id AND lav.apresentadora_id = a1.id)
      ) ap_v2
      LEFT JOIN apresentadoras a ON a.id = ap_v2.apresentadora_id AND a.tenant_id = l.tenant_id
      LEFT JOIN LATERAL (
        SELECT SUM(va.pedidos)::int AS pedidos FROM vendas_atribuidas va
        WHERE va.tenant_id = l.tenant_id AND va.origem = 'live' AND va.origem_id = l.id
          AND va.apresentadora_id = ap_v2.apresentadora_id
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
      ) venda ON true
      LEFT JOIN LATERAL (
        SELECT SUM(EXTRACT(EPOCH FROM (aea.data_fim - aea.data_inicio))) / 3600.0 AS horas_turno
        FROM agenda_evento_apresentadoras aea
        WHERE aea.agenda_evento_id = l.agenda_evento_id AND aea.tenant_id = l.tenant_id
          AND aea.apresentadora_id = ap_v2.apresentadora_id
      ) turno ON true
    ) part ON true
    WHERE l.tenant_id = $1::uuid
      AND ${activeLiveSql()} AND ${notArchivedSql()}
      AND l.iniciado_em >= ($2::date)::timestamp AT TIME ZONE '${TZ}'
      AND l.iniciado_em < (($3::date + 1)::timestamp AT TIME ZONE '${TZ}')
      AND ($4::uuid IS NULL OR l.marca_id = $4::uuid)
      AND ($5::uuid IS NULL OR l.cabine_id = $5::uuid)
      AND ($9::uuid IS NULL OR l.id = $9::uuid)
      AND l.status = $7::text AND $8::text <> 'video'
  ), video_facts AS (
    SELECT va.origem_id AS id, 'video'::text AS origem, va.data::date::text AS dia,
      NULL::timestamptz AS iniciado_em, NULL::timestamptz AS encerrado_em, 'encerrada'::text AS status,
      va.marca_id, m.nome AS marca_nome, NULL::uuid AS cabine_id, NULL::text AS cabine_nome,
      SUM(va.gmv) AS gmv, SUM(va.pedidos)::int AS pedidos,
      bool_and(va.gmv IS NOT NULL) AS gmv_registrado, 0::numeric AS horas,
      jsonb_agg(jsonb_build_object('id', va.apresentadora_id, 'nome', a.nome,
        'gmv', va.gmv, 'pedidos', va.pedidos, 'horas_presenca', 0, 'horas_produtividade', 0,
        'presenca_estimada', false)) AS participantes
    FROM vendas_atribuidas va
    LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
    LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
    WHERE va.tenant_id = $1::uuid AND va.origem = 'video'
      AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
      AND va.data >= $2::date AND va.data <= $3::date
      AND ($4::uuid IS NULL OR va.marca_id = $4::uuid)
      AND $5::uuid IS NULL AND $9::uuid IS NULL AND $7::text = 'encerrada' AND $8::text <> 'live'
    GROUP BY va.origem_id, va.data::date, va.marca_id, m.nome
  )
  SELECT * FROM (SELECT * FROM live_facts UNION ALL SELECT * FROM video_facts) facts
  WHERE $6::uuid IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(facts.participantes) p WHERE p->>'id' = $6::text)
  ORDER BY dia, origem, id LIMIT 10001
`

export async function loadFacts(app, user, args) {
  const rows = await app.withTenant(user.tenant_id, async db => {
    await db.query('BEGIN READ ONLY')
    try {
      await db.query("SET LOCAL statement_timeout = '10s'")
      const result = await db.query(MCP_FACTS_SQL, [user.tenant_id, args.inicio, args.fim,
        args.marca_id || null, args.cabine_id || null, args.apresentadora_id || null, args.status || 'encerrada', args.origem || 'ambos', args.live_id || null])
      await db.query('COMMIT')
      return result.rows
    } catch (error) { await db.query('ROLLBACK'); throw error }
  })
  if (rows.length > 10000) throw Object.assign(new Error('Mais de 10.000 registros; reduza o período ou filtre a consulta'), { statusCode: 422 })
  return rows
}

function total(facts, apresentadoraId) {
  let centsLive = 0, centsVideo = 0, pedidos = 0, horas = 0, presenca = 0, produtividade = 0, estimada = false
  const lives = new Set(), videos = new Set()
  for (const fact of facts) {
    const parts = apresentadoraId ? (fact.participantes || []).filter(p => p.id === apresentadoraId) : []
    const gmv = apresentadoraId ? parts.reduce((s, p) => s + n(p.gmv), 0) : n(fact.gmv)
    if (fact.origem === 'live') {
      centsLive += Math.round(gmv * 100); lives.add(fact.id)
      horas += n(fact.horas)
      for (const p of parts) {
        presenca += n(p.horas_presenca); produtividade += n(p.horas_produtividade)
        estimada ||= Boolean(p.presenca_estimada)
      }
    } else { centsVideo += Math.round(gmv * 100); videos.add(fact.id) }
    pedidos += apresentadoraId ? parts.reduce((s, p) => s + n(p.pedidos), 0) : n(fact.pedidos)
  }
  const divisor = apresentadoraId ? produtividade : horas
  const missingLive = facts.filter(f => f.origem === 'live' && f.gmv_registrado === false).length
  const missingVideo = facts.filter(f => f.origem === 'video' && f.gmv_registrado === false).length
  return { gmv_total: missingLive + missingVideo ? null : (centsLive + centsVideo) / 100,
    gmv_lives: missingLive ? null : centsLive / 100, gmv_videos: missingVideo ? null : centsVideo / 100,
    gmv_conhecido: (centsLive + centsVideo) / 100,
    cobertura: { registros: facts.length, lives_sem_gmv_registrado: missingLive, videos_sem_gmv_registrado: missingVideo },
    pedidos, total_lives: lives.size, total_videos: videos.size,
    ...(apresentadoraId ? { horas_presenca: round(presenca), horas_produtividade: round(produtividade), presenca_estimada: estimada }
      : { horas_transmissao: round(horas) }),
    ticket_medio: pedidos > 0 && !missingLive && !missingVideo ? round((centsLive + centsVideo) / 100 / pedidos) : null,
    gmv_por_hora: divisor > 0 && !missingLive ? round(centsLive / 100 / divisor) : null,
    denominador_gmv_hora: apresentadoraId ? 'horas_produtividade' : 'horas_transmissao' }
}

export function aggregateFacts(facts, groupBy, apresentadoraId) {
  if (!groupBy) return total(facts, apresentadoraId)
  const groups = new Map()
  for (const fact of facts) {
    const entities = groupBy === 'apresentadora' ? (fact.participantes || []).filter(p => p.id)
      : [{ id: fact[`${groupBy}_id`], nome: fact[`${groupBy}_nome`] }]
    for (const entity of entities) {
      if (!groups.has(entity.id)) groups.set(entity.id, { id: entity.id, nome: entity.nome || 'Não identificado', facts: new Set() })
      groups.get(entity.id).facts.add(fact)
    }
  }
  const rows = [...groups.values()].map(g => ({ id: g.id, nome: g.nome, ...total([...g.facts], groupBy === 'apresentadora' ? g.id : apresentadoraId) }))
  const sum = rows.every(r => r.gmv_total !== null) ? rows.reduce((s, r) => s + r.gmv_total, 0) : null
  return rows.map(r => ({ ...r, participacao_gmv_percentual: sum > 0 && r.gmv_total !== null ? round(r.gmv_total / sum * 100) : null }))
    .sort((a, b) => b.gmv_total - a.gmv_total || a.nome.localeCompare(b.nome))
}

export function evolution(facts, period, granularidade = 'dia', apresentadoraId) {
  const buckets = new Map()
  for (let day = period.inicio; day <= period.fim; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    buckets.set(granularidade === 'mes' ? day.slice(0, 7) : day, [])
  }
  for (const fact of facts) buckets.get(granularidade === 'mes' ? fact.dia.slice(0, 7) : fact.dia)?.push(fact)
  let cents = 0, incomplete = false
  return [...buckets].map(([periodo, rows]) => {
    const result = total(rows, apresentadoraId)
    incomplete ||= result.gmv_total === null
    cents += Math.round(result.gmv_conhecido * 100)
    return { periodo, ...result, gmv_acumulado: incomplete ? null : cents / 100, gmv_conhecido_acumulado: cents / 100 }
  })
}

export function compareMetrics(current, previous) {
  return Object.fromEntries(Object.keys(current).filter(key => typeof current[key] === 'number' && typeof previous[key] === 'number').map(key => {
    const atual = current[key], anterior = previous[key]
    return [key, { atual, anterior, diferenca: round(atual - anterior), variacao_percentual: anterior !== 0 ? round((atual - anterior) / Math.abs(anterior) * 100) : null }]
  }))
}
