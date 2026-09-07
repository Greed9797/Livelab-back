import { apresentadoraHorasSql, liveGmvSql, liveOrdersSql } from '../lib/metric-sql.js'

// Performance is read only from official closed lives. Pending portal submissions
// intentionally never participate in this query. UNION keeps legacy + v2 links
// from counting a transmission twice for the same presenter.
export async function getOwnPortalPerformance(db, { tenantId, apresentadoraId, range }) {
  const result = await db.query(`
    WITH own_profile AS (
      SELECT id, user_id FROM apresentadoras WHERE tenant_id=$1::uuid AND id=$2::uuid
    ), own_lives AS (
      SELECT l.id FROM lives l JOIN own_profile a ON a.user_id=l.apresentador_id
      WHERE l.tenant_id=$1::uuid
      UNION
      SELECT la.live_id FROM live_apresentadores la JOIN own_profile a ON a.user_id=la.apresentador_id
      JOIN lives l ON l.id=la.live_id AND l.tenant_id=la.tenant_id
      WHERE la.tenant_id=$1::uuid
      UNION
      SELECT lav.live_id FROM live_apresentadoras_v2 lav JOIN own_profile a ON a.id=lav.apresentadora_id
      JOIN lives l ON l.id=lav.live_id AND l.tenant_id=lav.tenant_id
      WHERE lav.tenant_id=$1::uuid
    )
    SELECT l.id, l.iniciado_em, l.encerrado_em, m.nome AS marca_nome, c.nome AS cabine_nome,
      CASE WHEN v2.apresentadora_id IS NOT NULL THEN COALESCE(
        v2.gmv_rateado, ${liveGmvSql('l')} * v2.percentual_rateio / 100.0,
        CASE WHEN v2.papel='principal' THEN ${liveGmvSql('l')} ELSE 0 END
      ) ELSE COALESCE(own_sales.gmv, ${liveGmvSql('l')} * attribution.percentual_rateio / 100.0) END AS gmv,
      CASE WHEN COALESCE(l.encerrado_em,l.previsto_fim)>l.iniciado_em
        THEN ${apresentadoraHorasSql({ live: 'l', rateio: 'attribution' })} ELSE 0 END AS horas,
      COALESCE(own_sales.pedidos,
        CASE WHEN v2.papel='principal' OR (v2.apresentadora_id IS NULL AND l.apresentador_id=(SELECT user_id FROM own_profile))
          THEN ${liveOrdersSql('l')} ELSE 0 END)::int AS pedidos
    FROM own_lives ol JOIN lives l ON l.id=ol.id AND l.tenant_id=$1::uuid
    LEFT JOIN marcas m ON m.id=l.marca_id AND m.tenant_id=l.tenant_id
    LEFT JOIN cabines c ON c.id=l.cabine_id AND c.tenant_id=l.tenant_id
    LEFT JOIN live_apresentadoras_v2 v2 ON v2.live_id=l.id AND v2.tenant_id=l.tenant_id AND v2.apresentadora_id=$2::uuid
    LEFT JOIN LATERAL (
      SELECT SUM(v.gmv) AS gmv, SUM(v.pedidos)::int AS pedidos
      FROM vendas_atribuidas v WHERE v.tenant_id=l.tenant_id AND v.origem='live'
        AND v.origem_id=l.id AND v.apresentadora_id=$2::uuid
        AND COALESCE(v.status_aprovacao,'pendente_aprovacao') <> 'reprovada'
    ) own_sales ON true
    LEFT JOIN LATERAL (
      -- Legacy records have no measured split time. Use the same residual
      -- percentage default as commission-engine, rather than crediting every
      -- legacy participant with the entire transmission. Existing v2 time and
      -- money shares retain precedence via the canonical metric helper.
      SELECT COUNT(*) FILTER (WHERE split.percentual_rateio IS NULL)::numeric AS unspecified,
        COALESCE(SUM(split.percentual_rateio),0) AS explicit_percentage
      FROM (
        SELECT a.id FROM apresentadoras a WHERE a.tenant_id=l.tenant_id AND a.user_id=l.apresentador_id
        UNION
        SELECT a.id FROM live_apresentadores la JOIN apresentadoras a ON a.user_id=la.apresentador_id AND a.tenant_id=la.tenant_id
          WHERE la.tenant_id=l.tenant_id AND la.live_id=l.id
        UNION
        SELECT s.apresentadora_id FROM live_apresentadoras_v2 s
          JOIN apresentadoras a ON a.id=s.apresentadora_id AND a.tenant_id=s.tenant_id
          WHERE s.tenant_id=l.tenant_id AND s.live_id=l.id
      ) participants
      LEFT JOIN live_apresentadoras_v2 split ON split.tenant_id=l.tenant_id AND split.live_id=l.id AND split.apresentadora_id=participants.id
    ) legacy ON v2.apresentadora_id IS NULL
    CROSS JOIN LATERAL (
      SELECT $2::uuid AS apresentadora_id, v2.segundos_rateio, v2.papel,
        CASE WHEN v2.apresentadora_id IS NOT NULL THEN v2.percentual_rateio
          ELSE GREATEST(0,100-COALESCE(legacy.explicit_percentage,0)) / GREATEST(COALESCE(legacy.unspecified,1),1)
        END AS percentual_rateio
    ) attribution
    WHERE l.status='encerrada'
      AND l.iniciado_em >= ($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND l.iniciado_em < ($4::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
    ORDER BY l.iniciado_em DESC,l.id
  `, [tenantId, apresentadoraId, range.start, range.end])

  // A DTO allowlist prevents future SELECT extensions leaking financial data.
  const items = result.rows.map(row => ({
    id: row.id, iniciado_em: row.iniciado_em, encerrado_em: row.encerrado_em,
    marca_nome: row.marca_nome ?? null, cabine_nome: row.cabine_nome ?? null,
    gmv: Number(row.gmv ?? 0), horas: Math.max(0, Number(row.horas ?? 0)), pedidos: Number(row.pedidos ?? 0),
  }))
  const sums = items.reduce((sum, item) => ({ gmv: sum.gmv + item.gmv, horas: sum.horas + item.horas, pedidos: sum.pedidos + item.pedidos }), { gmv: 0, horas: 0, pedidos: 0 })
  return { items, desempenho: {
    total_lives: items.length, gmv_lives: Math.round(sums.gmv * 100) / 100,
    horas_live: Math.round(sums.horas * 100) / 100,
    gmv_por_hora: sums.horas > 0 ? Math.round(sums.gmv / sums.horas * 100) / 100 : null,
    pedidos: sums.pedidos,
  } }
}
