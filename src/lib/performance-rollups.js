import { presenterFixedSql } from '../config/presenter_defaults.js'

const ANALYTICS_TZ = 'America/Sao_Paulo'

function num(value) {
  return Number(value ?? 0)
}

export function mapPerformanceRows(rows, { groupBy, mes } = {}) {
  return rows.map((row) => {
    const gmvLives = num(row.gmv_lives)
    const horasLive = num(row.horas_live)
    const base = {
      gmv_total: num(row.gmv_total),
      gmv: num(row.gmv_total),
      gmv_lives: gmvLives,
      gmv_videos: num(row.gmv_videos),
      horas_live: Math.round(horasLive * 10) / 10,
      // GMV de live por hora de live (eficiência operacional por entidade).
      gmv_por_hora: horasLive > 0 ? Math.round((gmvLives / horasLive) * 100) / 100 : 0,
      pedidos: num(row.pedidos),
      pedidos_total: num(row.pedidos),
      total_lives: num(row.total_lives),
      lives: num(row.total_lives),
      total_videos: num(row.total_videos),
      comissao_apresentadora: num(row.comissao_apresentadora),
      comissao_apresentadoras: num(row.comissao_apresentadora),
      comissao_variavel: num(row.comissao_variavel ?? row.comissao_apresentadora),
      comissao_franquia: num(row.comissao_franquia),
      comissao_franqueadora: num(row.comissao_franqueadora),
      comissao_fixo: num(row.comissao_fixo),
      fixo: num(row.fixo),
      total_recebido: num(row.total_recebido),
      registros: num(row.registros),
      mes,
    }

    if (groupBy === 'marca') {
      return {
        ...base,
        id: row.marca_id,
        marca_id: row.marca_id,
        nome: row.marca_nome ?? 'Sem marca',
        marca_nome: row.marca_nome ?? 'Sem marca',
        logo_url: row.logo_url ?? null,
        site: row.site ?? null,
      }
    }

    return {
      ...base,
      id: row.apresentadora_id,
      apresentadora_id: row.apresentadora_id,
      apresentador_id: row.apresentadora_id,
      nome: row.apresentadora_nome ?? 'Sem apresentadora',
      apresentadora_nome: row.apresentadora_nome ?? 'Sem apresentadora',
      apresentador_nome: row.apresentadora_nome ?? 'Sem apresentadora',
      foto_url: row.apresentadora_foto_url ?? null,
      apresentadora_foto_url: row.apresentadora_foto_url ?? null,
    }
  })
}

export async function getPerformanceRanking(db, {
  tenantId,
  range,
  groupBy,
  limit = 50,
  clienteId = null,
  marcaId = null,
  apresentadoraId = null,
  origem = null,
}) {
  if (!['apresentadora', 'marca'].includes(groupBy)) {
    throw new Error("groupBy must be 'apresentadora' or 'marca'")
  }

  const originFilter = origem && origem !== 'all' ? origem : null
  const params = [tenantId, range.start, range.end, limit, clienteId, marcaId, apresentadoraId, originFilter]

  if (groupBy === 'marca') {
    const result = await db.query(`
      WITH live_source AS (
        SELECT
          l.marca_id,
          l.id AS origem_id,
          'live' AS origem,
          COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv,
          COALESCE(l.manual_orders, l.final_orders_count, 0)::int AS pedidos,
          COALESCE(live_commission.comissao_apresentadora, 0) AS comissao_apresentadora,
          COALESCE(live_commission.comissao_franquia, 0) AS comissao_franquia,
          COALESCE(live_commission.comissao_franqueadora, 0) AS comissao_franqueadora,
          CASE
            WHEN COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
              THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
            ELSE 0
          END AS horas,
          date_trunc('month', (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')) AS mes
        FROM lives l
        LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
        LEFT JOIN LATERAL (
          SELECT lav.apresentadora_id
          FROM live_apresentadoras_v2 lav
          WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
          ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
          LIMIT 1
        ) ap_v2 ON true
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_apresentadora,
            COALESCE(SUM(va.comissao_franquia), 0) AS comissao_franquia,
            COALESCE(SUM(va.comissao_franqueadora), 0) AS comissao_franqueadora
          FROM vendas_atribuidas va
          WHERE va.tenant_id = l.tenant_id
            AND va.origem = 'live'
            AND va.origem_id = l.id
            AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
        ) live_commission ON true
        WHERE l.tenant_id = $1::uuid
          AND l.status = 'encerrada'
          AND l.iniciado_em >= ($2::date) AT TIME ZONE '${ANALYTICS_TZ}'
          AND l.iniciado_em < ($3::date) AT TIME ZONE '${ANALYTICS_TZ}'
          AND ($5::uuid IS NULL OR l.cliente_id = $5::uuid)
          AND ($6::uuid IS NULL OR l.marca_id = $6::uuid)
          AND ($7::uuid IS NULL OR COALESCE(ap_v2.apresentadora_id, ap_user.id) = $7::uuid)
          AND ($8::text IS NULL OR $8::text = 'live')
      ),
      video_source AS (
        SELECT
          va.marca_id,
          va.origem_id,
          va.origem,
          va.gmv,
          va.pedidos,
          va.comissao_apresentadora,
          va.comissao_franquia,
          va.comissao_franqueadora,
          0 AS horas,
          date_trunc('month', va.data::timestamp) AS mes
        FROM vendas_atribuidas va
        JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
        WHERE va.tenant_id = $1::uuid
          AND va.origem = 'video'
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
          AND va.data >= $2::date
          AND va.data < $3::date
          AND ($5::uuid IS NULL OR m.cliente_id = $5::uuid)
          AND ($6::uuid IS NULL OR va.marca_id = $6::uuid)
          AND ($7::uuid IS NULL OR va.apresentadora_id = $7::uuid)
          AND ($8::text IS NULL OR $8::text = 'video')
      ),
      combined AS (
        SELECT * FROM live_source
        UNION ALL
        SELECT * FROM video_source
      )
      SELECT
        combined.marca_id,
        m.nome AS marca_nome,
        COALESCE(m.logo_url, c.logo_url) AS logo_url,
        COALESCE(m.site, c.site) AS site,
        COALESCE(SUM(combined.gmv), 0) AS gmv_total,
        COALESCE(SUM(combined.gmv) FILTER (WHERE combined.origem = 'live'), 0) AS gmv_lives,
        COALESCE(SUM(combined.gmv) FILTER (WHERE combined.origem = 'video'), 0) AS gmv_videos,
        COALESCE(SUM(combined.horas), 0) AS horas_live,
        COALESCE(SUM(combined.pedidos), 0)::int AS pedidos,
        COUNT(DISTINCT combined.origem_id) FILTER (WHERE combined.origem = 'live')::int AS total_lives,
        COUNT(DISTINCT combined.origem_id) FILTER (WHERE combined.origem = 'video')::int AS total_videos,
        COALESCE(SUM(combined.comissao_apresentadora), 0) AS comissao_apresentadora,
        -- Fixo mensal (marcas.valor_fixo_minimo) SOMA ao comissionamento da marca tipo='cliente',
        -- uma vez por mês COM comissionamento gerado (GMV/pedidos > 0), em franquia E franqueadora.
        -- O FILTER alinha com o HAVING (gmv/pedidos <> 0) e com o financeiro: as duas telas concordam.
        COALESCE(SUM(combined.comissao_franquia), 0)
          + COALESCE(MAX(CASE WHEN m.tipo = 'cliente' THEN m.valor_fixo_minimo ELSE 0 END), 0)
            * COUNT(DISTINCT combined.mes) FILTER (WHERE combined.gmv > 0 OR combined.pedidos > 0) AS comissao_franquia,
        COALESCE(SUM(combined.comissao_franqueadora), 0)
          + COALESCE(MAX(CASE WHEN m.tipo = 'cliente' THEN m.valor_fixo_minimo ELSE 0 END), 0)
            * COUNT(DISTINCT combined.mes) FILTER (WHERE combined.gmv > 0 OR combined.pedidos > 0) AS comissao_franqueadora,
        COALESCE(MAX(CASE WHEN m.tipo = 'cliente' THEN m.valor_fixo_minimo ELSE 0 END), 0)
          * COUNT(DISTINCT combined.mes) FILTER (WHERE combined.gmv > 0 OR combined.pedidos > 0) AS comissao_fixo,
        COUNT(*)::int AS registros
      FROM combined
      LEFT JOIN marcas m ON m.id = combined.marca_id AND m.tenant_id = $1::uuid
      LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
      GROUP BY combined.marca_id, m.nome, COALESCE(m.logo_url, c.logo_url), COALESCE(m.site, c.site)
      HAVING COALESCE(SUM(combined.gmv), 0) <> 0 OR COALESCE(SUM(combined.pedidos), 0) <> 0
      ORDER BY gmv_total DESC, pedidos DESC, marca_nome ASC
      LIMIT $4::int
    `, params)

    return mapPerformanceRows(result.rows, { groupBy, mes: range.mes })
  }

  const result = await db.query(`
    WITH live_source AS (
      SELECT
        COALESCE(ap_v2.apresentadora_id, ap_user.id) AS apresentadora_id,
        l.marca_id,
        l.id AS origem_id,
        'live' AS origem,
        COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv,
        COALESCE(l.manual_orders, l.final_orders_count, 0)::int AS pedidos,
        COALESCE(live_commission.comissao_apresentadora, 0) AS comissao_apresentadora,
        CASE
          WHEN COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
            THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
          ELSE 0
        END AS horas
      FROM lives l
      LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
      LEFT JOIN LATERAL (
        SELECT lav.apresentadora_id
        FROM live_apresentadoras_v2 lav
        WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
        ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
        LIMIT 1
      ) ap_v2 ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_apresentadora
        FROM vendas_atribuidas va
        WHERE va.tenant_id = l.tenant_id
          AND va.origem = 'live'
          AND va.origem_id = l.id
          AND va.apresentadora_id = COALESCE(ap_v2.apresentadora_id, ap_user.id)
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
      ) live_commission ON true
      WHERE l.tenant_id = $1::uuid
        AND l.status = 'encerrada'
        AND l.iniciado_em >= ($2::date) AT TIME ZONE '${ANALYTICS_TZ}'
        AND l.iniciado_em < ($3::date) AT TIME ZONE '${ANALYTICS_TZ}'
        AND ($5::uuid IS NULL OR l.cliente_id = $5::uuid)
        AND ($6::uuid IS NULL OR l.marca_id = $6::uuid)
        AND ($7::uuid IS NULL OR COALESCE(ap_v2.apresentadora_id, ap_user.id) = $7::uuid)
        AND ($8::text IS NULL OR $8::text = 'live')
    ),
    video_source AS (
      SELECT
        va.apresentadora_id,
        va.marca_id,
        va.origem_id,
        va.origem,
        va.gmv,
        va.pedidos,
        va.comissao_apresentadora,
        0 AS horas
      FROM vendas_atribuidas va
      JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
      WHERE va.tenant_id = $1::uuid
        AND va.origem = 'video'
        AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
        AND va.data >= $2::date
        AND va.data < $3::date
        AND ($5::uuid IS NULL OR m.cliente_id = $5::uuid)
        AND ($6::uuid IS NULL OR va.marca_id = $6::uuid)
        AND ($7::uuid IS NULL OR va.apresentadora_id = $7::uuid)
        AND ($8::text IS NULL OR $8::text = 'video')
    ),
    combined AS (
      SELECT * FROM live_source
      UNION ALL
      SELECT * FROM video_source
    )
    SELECT
      combined.apresentadora_id,
      COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome,
      a.foto_url AS apresentadora_foto_url,
      MAX(${presenterFixedSql('a')}) AS fixo,
      COALESCE(SUM(combined.gmv), 0) AS gmv_total,
      COALESCE(SUM(combined.gmv) FILTER (WHERE combined.origem = 'live'), 0) AS gmv_lives,
      COALESCE(SUM(combined.gmv) FILTER (WHERE combined.origem = 'video'), 0) AS gmv_videos,
      COALESCE(SUM(combined.horas), 0) AS horas_live,
      COALESCE(SUM(combined.pedidos), 0)::int AS pedidos,
      COUNT(DISTINCT combined.origem_id) FILTER (WHERE combined.origem = 'live')::int AS total_lives,
      COUNT(DISTINCT combined.origem_id) FILTER (WHERE combined.origem = 'video')::int AS total_videos,
      COALESCE(SUM(combined.comissao_apresentadora), 0) AS comissao_apresentadora,
      COALESCE(SUM(combined.comissao_apresentadora), 0) AS comissao_variavel,
      (MAX(${presenterFixedSql('a')}) + COALESCE(SUM(combined.comissao_apresentadora), 0)) AS total_recebido,
      COUNT(*)::int AS registros
    FROM combined
    LEFT JOIN apresentadoras a ON a.id = combined.apresentadora_id AND a.tenant_id = $1::uuid
    GROUP BY combined.apresentadora_id, a.nome, a.foto_url
    HAVING COALESCE(SUM(combined.gmv), 0) <> 0 OR COALESCE(SUM(combined.pedidos), 0) <> 0
    ORDER BY gmv_total DESC, total_recebido DESC, apresentadora_nome ASC
    LIMIT $4::int
  `, params)

  return mapPerformanceRows(result.rows, { groupBy, mes: range.mes })
}
