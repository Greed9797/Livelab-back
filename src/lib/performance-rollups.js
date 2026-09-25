import { presenterFixedCapSql } from '../config/presenter_defaults.js'
import { apresentadoraHorasSql } from './metric-sql.js'
import { liveGmvSql } from './metric-sql.js'
import { activeLiveSql } from './live-merge-sql.js'
import { notArchivedSql } from './live-count-sql.js'

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
          CASE
            WHEN $7::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
              THEN COALESCE(
                ap_v2.gmv_rateado,
                COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) * ap_v2.percentual_rateio / 100.0,
                CASE WHEN ap_v2.papel = 'principal' THEN COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) ELSE 0 END
              )
            ELSE COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)
          END AS gmv,
          CASE
            WHEN $7::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
              THEN COALESCE(live_commission.pedidos, CASE WHEN ap_v2.papel = 'principal' THEN COALESCE(l.manual_orders, l.final_orders_count, 0) ELSE 0 END)
            ELSE COALESCE(l.manual_orders, l.final_orders_count, 0)
          END::int AS pedidos,
          COALESCE(live_commission.comissao_apresentadora, 0) AS comissao_apresentadora,
          CASE WHEN mc.id IS NOT NULL
            THEN COALESCE((CASE
              WHEN $7::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
                THEN COALESCE(ap_v2.gmv_rateado,
                  ${liveGmvSql('l')} * ap_v2.percentual_rateio / 100.0,
                  CASE WHEN ap_v2.papel = 'principal' THEN ${liveGmvSql('l')} ELSE 0 END)
              ELSE ${liveGmvSql('l')}
            END) * mc.comissao_franquia_pct / 100.0, 0)
            ELSE COALESCE(live_commission.comissao_franquia, 0)
          END AS comissao_franquia,
          CASE WHEN mc.id IS NOT NULL
            THEN COALESCE((CASE
              WHEN $7::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
                THEN COALESCE(ap_v2.gmv_rateado,
                  ${liveGmvSql('l')} * ap_v2.percentual_rateio / 100.0,
                  CASE WHEN ap_v2.papel = 'principal' THEN ${liveGmvSql('l')} ELSE 0 END)
              ELSE ${liveGmvSql('l')}
            END) * mc.comissao_franqueadora_pct / 100.0, 0)
            ELSE COALESCE(live_commission.comissao_franqueadora, 0)
          END AS comissao_franqueadora,
          CASE
            WHEN $7::uuid IS NOT NULL AND ap_v2.apresentadora_id IS NOT NULL
              THEN COALESCE(
                ap_v2.segundos_rateio / 3600.0,
                LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0) * ap_v2.percentual_rateio / 100.0,
                CASE WHEN ap_v2.papel = 'principal' THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0) ELSE 0 END
              )
            WHEN COALESCE(l.encerrado_em, l.previsto_fim) > l.iniciado_em
              THEN LEAST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em, l.previsto_fim) - l.iniciado_em)) / 3600.0, 24.0)
            ELSE 0
          END AS horas,
          date_trunc('month', (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')) AS mes
        FROM lives l
        LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
        LEFT JOIN LATERAL (
          SELECT lav.apresentadora_id, lav.gmv_rateado, lav.segundos_rateio,
                 lav.percentual_rateio, lav.papel
          FROM live_apresentadoras_v2 lav
          WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
            AND ($7::uuid IS NULL OR lav.apresentadora_id = $7::uuid)
          ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
          LIMIT 1
        ) ap_v2 ON true
        LEFT JOIN LATERAL (
          SELECT c.id, c.comissao_franquia_pct, c.comissao_franqueadora_pct
            FROM marca_condicoes_comerciais c
           WHERE c.tenant_id = l.tenant_id
             AND c.marca_id = l.marca_id
             AND c.inicio_vigencia <= (l.iniciado_em AT TIME ZONE '${ANALYTICS_TZ}')::date
             AND c.cancelled_at IS NULL
           ORDER BY c.inicio_vigencia DESC
           LIMIT 1
        ) mc ON true
        LEFT JOIN LATERAL (
          SELECT
            SUM(va.pedidos)::int AS pedidos,
            COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_apresentadora,
            COALESCE(SUM(va.comissao_franquia), 0) AS comissao_franquia,
            COALESCE(SUM(va.comissao_franqueadora), 0) AS comissao_franqueadora
          FROM vendas_atribuidas va
          WHERE va.tenant_id = l.tenant_id
            AND va.origem = 'live'
            AND va.origem_id = l.id
            AND ($7::uuid IS NULL OR va.apresentadora_id = $7::uuid)
            AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
        ) live_commission ON true
        WHERE l.tenant_id = $1::uuid
          AND l.status = 'encerrada'
          AND ${activeLiveSql('l')}
          AND ${notArchivedSql('l')}
          AND l.iniciado_em >= ($2::timestamp) AT TIME ZONE '${ANALYTICS_TZ}'
          AND l.iniciado_em < ($3::timestamp) AT TIME ZONE '${ANALYTICS_TZ}'
          AND ($5::uuid IS NULL OR l.cliente_id = $5::uuid)
          AND ($6::uuid IS NULL OR l.marca_id = $6::uuid)
          AND (
            ap_v2.apresentadora_id IS NOT NULL
            OR NOT EXISTS (
              SELECT 1 FROM live_apresentadoras_v2 lav_any
              WHERE lav_any.live_id = l.id AND lav_any.tenant_id = l.tenant_id
            )
          )
          AND (
            $7::uuid IS NULL
            OR ap_v2.apresentadora_id = $7::uuid
            OR (ap_v2.apresentadora_id IS NULL AND ap_user.id = $7::uuid)
          )
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
      ,marca_composicao AS (
        SELECT combined.marca_id, combined.mes,
               COALESCE(SUM(combined.comissao_franquia), 0) AS comissao,
               COALESCE(MAX(CASE WHEN m.tipo = 'cliente'
                 THEN COALESCE(mc.fixo_mensal, m.valor_fixo_minimo) ELSE 0 END), 0) AS fixo,
               COALESCE(MAX(CASE WHEN m.tipo = 'cliente'
                 THEN COALESCE(mc.tipo_cobranca, m.tipo_cobranca, 'fixo_mais_comissao')
                 ELSE 'fixo_mais_comissao' END), 'fixo_mais_comissao') AS tipo_cobranca
          FROM combined
          LEFT JOIN marcas m ON m.id = combined.marca_id AND m.tenant_id = $1::uuid
          LEFT JOIN LATERAL (
            SELECT c.fixo_mensal, c.tipo_cobranca
              FROM marca_condicoes_comerciais c
             WHERE c.tenant_id = $1::uuid
               AND c.marca_id = combined.marca_id
               AND c.inicio_vigencia <= combined.mes::date
               AND c.cancelled_at IS NULL
             ORDER BY c.inicio_vigencia DESC
             LIMIT 1
          ) mc ON true
         WHERE combined.gmv > 0 OR combined.pedidos > 0
         GROUP BY combined.marca_id, combined.mes
      ),
      marca_totais AS (
        SELECT marca_id,
               COALESCE(SUM(fixo), 0) AS fixo,
               COALESCE(SUM(comissao), 0) AS comissao_variavel,
               COALESCE(SUM(CASE WHEN tipo_cobranca = 'fixo_ou_comissao'
                 THEN GREATEST(fixo, comissao) ELSE fixo + comissao END), 0) AS receita
          FROM marca_composicao
         GROUP BY marca_id
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
        COALESCE(MAX(mt.receita), 0) AS comissao_franquia,
        COALESCE(SUM(combined.comissao_franqueadora), 0) + COALESCE(MAX(mt.fixo), 0) AS comissao_franqueadora,
        COALESCE(MAX(mt.fixo), 0) AS comissao_fixo,
        COUNT(*)::int AS registros
      FROM combined
      LEFT JOIN marcas m ON m.id = combined.marca_id AND m.tenant_id = $1::uuid
      LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
      LEFT JOIN marca_totais mt ON mt.marca_id = combined.marca_id
      GROUP BY combined.marca_id, m.nome, COALESCE(m.logo_url, c.logo_url), COALESCE(m.site, c.site)
      HAVING COUNT(*) FILTER (WHERE combined.origem = 'live') > 0
        OR COALESCE(SUM(combined.gmv), 0) <> 0
        OR COALESCE(SUM(combined.pedidos), 0) <> 0
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
        CASE
          WHEN ap_v2.apresentadora_id IS NOT NULL
            THEN COALESCE(
              ap_v2.gmv_rateado,
              COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) * ap_v2.percentual_rateio / 100.0,
              CASE WHEN ap_v2.papel = 'principal' THEN COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) ELSE 0 END
            )
          ELSE COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)
        END AS gmv,
        COALESCE(
          live_commission.pedidos,
          CASE WHEN ap_v2.apresentadora_id IS NULL OR ap_v2.papel = 'principal'
            THEN COALESCE(l.manual_orders, l.final_orders_count, 0)
            ELSE 0
          END
        )::int AS pedidos,
        COALESCE(live_commission.comissao_apresentadora, 0) AS comissao_apresentadora,
        ${apresentadoraHorasSql()} AS horas
      FROM lives l
      LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
      LEFT JOIN LATERAL (
        SELECT lav.apresentadora_id, lav.gmv_rateado, lav.segundos_rateio,
               lav.percentual_rateio, lav.papel
        FROM live_apresentadoras_v2 lav
        WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
          AND ($7::uuid IS NULL OR lav.apresentadora_id = $7::uuid)
      ) ap_v2 ON true
      LEFT JOIN LATERAL (
        SELECT SUM(va.pedidos)::int AS pedidos,
               COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_apresentadora
        FROM vendas_atribuidas va
        WHERE va.tenant_id = l.tenant_id
          AND va.origem = 'live'
          AND va.origem_id = l.id
          AND va.apresentadora_id = COALESCE(ap_v2.apresentadora_id, ap_user.id)
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
      ) live_commission ON true
      WHERE l.tenant_id = $1::uuid
        AND l.status = 'encerrada'
        AND ${activeLiveSql('l')}
        AND ${notArchivedSql('l')}
        AND l.iniciado_em >= ($2::timestamp) AT TIME ZONE '${ANALYTICS_TZ}'
        AND l.iniciado_em < ($3::timestamp) AT TIME ZONE '${ANALYTICS_TZ}'
        AND ($5::uuid IS NULL OR l.cliente_id = $5::uuid)
        AND ($6::uuid IS NULL OR l.marca_id = $6::uuid)
        AND (
          ap_v2.apresentadora_id IS NOT NULL
          OR NOT EXISTS (
            SELECT 1 FROM live_apresentadoras_v2 lav_any
            WHERE lav_any.live_id = l.id AND lav_any.tenant_id = l.tenant_id
          )
        )
        AND (
          $7::uuid IS NULL
          OR ap_v2.apresentadora_id = $7::uuid
          OR (ap_v2.apresentadora_id IS NULL AND ap_user.id = $7::uuid)
        )
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
    ),
    -- Fixo VIGENTE no último dia da janela (migration 137), resolvido UMA vez por
    -- apresentadora. Não usar subquery correlacionada aqui: ela seria reexecutada por
    -- linha de \`combined\` (uma por live e por venda de vídeo), e este SQL serve a Home
    -- com polling de 15s e ao ranking público sem autenticação.
    -- $3 é EXCLUSIVO (\`va.data < $3\`), por isso -1 dia: sem isso, um reajuste feito no
    -- dia 1º de setembro entraria no fechamento de agosto.
    -- tenant_id explícito: o ranking público roda pelo pool de sistema, sem RLS.
    fixo_vigente AS (
      SELECT DISTINCT ON (apresentadora_id) apresentadora_id, valor
        FROM apresentadora_fixo_historico
       WHERE tenant_id = $1::uuid
         AND vigencia_inicio <= ($3::date - 1)
       ORDER BY apresentadora_id, vigencia_inicio DESC, id DESC
    )
    SELECT
      combined.apresentadora_id,
      COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome,
      a.foto_url AS apresentadora_foto_url,
      MAX(${presenterFixedCapSql('COALESCE(fv.valor, a.fixo)')}) AS fixo,
      COALESCE(SUM(combined.gmv), 0) AS gmv_total,
      COALESCE(SUM(combined.gmv) FILTER (WHERE combined.origem = 'live'), 0) AS gmv_lives,
      COALESCE(SUM(combined.gmv) FILTER (WHERE combined.origem = 'video'), 0) AS gmv_videos,
      COALESCE(SUM(combined.horas), 0) AS horas_live,
      COALESCE(SUM(combined.pedidos), 0)::int AS pedidos,
      COUNT(DISTINCT combined.origem_id) FILTER (WHERE combined.origem = 'live')::int AS total_lives,
      COUNT(DISTINCT combined.origem_id) FILTER (WHERE combined.origem = 'video')::int AS total_videos,
      COALESCE(SUM(combined.comissao_apresentadora), 0) AS comissao_apresentadora,
      COALESCE(SUM(combined.comissao_apresentadora), 0) AS comissao_variavel,
      (MAX(${presenterFixedCapSql('COALESCE(fv.valor, a.fixo)')}) + COALESCE(SUM(combined.comissao_apresentadora), 0)) AS total_recebido,
      COUNT(*)::int AS registros
    FROM combined
    LEFT JOIN apresentadoras a ON a.id = combined.apresentadora_id AND a.tenant_id = $1::uuid
    LEFT JOIN fixo_vigente fv ON fv.apresentadora_id = combined.apresentadora_id
    GROUP BY combined.apresentadora_id, a.nome, a.foto_url
    HAVING COUNT(*) FILTER (WHERE combined.origem = 'live') > 0
      OR COALESCE(SUM(combined.gmv), 0) <> 0
      OR COALESCE(SUM(combined.pedidos), 0) <> 0
    ORDER BY gmv_total DESC, total_recebido DESC, apresentadora_nome ASC
    LIMIT $4::int
  `, params)

  return mapPerformanceRows(result.rows, { groupBy, mes: range.mes })
}
