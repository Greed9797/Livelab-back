import { presenterFixedSql } from '../config/presenter_defaults.js'

export function monthRangeFromQuery(query = {}) {
  const mes = typeof query?.mes === 'string' && /^\d{4}-\d{2}$/.test(query.mes)
    ? query.mes
    : new Date().toISOString().slice(0, 7)
  const start = `${mes}-01`
  const endDate = new Date(`${start}T00:00:00.000Z`)
  endDate.setUTCMonth(endDate.getUTCMonth() + 1)
  return { mes, start, end: endDate.toISOString().slice(0, 10) }
}

export function limitFromQuery(query = {}, fallback = 50) {
  const raw = Number(query?.limit ?? fallback)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(Math.max(Math.trunc(raw), 1), 100)
}

export function mapPresenterRankingRows(rows, mes) {
  return rows.map((row) => ({
    ...row,
    id: row.id ?? row.apresentadora_id,
    apresentadora_id: row.apresentadora_id ?? row.id,
    nome: row.nome ?? row.apresentadora_nome,
    apresentadora_nome: row.apresentadora_nome ?? row.nome,
    foto_url: row.foto_url ?? row.apresentadora_foto_url ?? null,
    apresentadora_foto_url: row.apresentadora_foto_url ?? row.foto_url ?? null,
    mes,
    gmv: Number(row.gmv ?? 0),
    gmv_lives: Number(row.gmv_lives ?? 0),
    gmv_videos: Number(row.gmv_videos ?? 0),
    lives: Number(row.lives ?? 0),
    pedidos: Number(row.pedidos ?? 0),
    fixo: Number(row.fixo ?? 0),
    comissao_variavel: Number(row.comissao_variavel ?? 0),
    total_recebido: Number(row.total_recebido ?? 0),
  }))
}

export async function getPresenterRanking(db, { tenantId, range = monthRangeFromQuery(), limit = 50 }) {
  const result = await db.query(
    `WITH ranking_apresentadoras_mes AS (
       SELECT
         a.id,
         a.id AS apresentadora_id,
         COALESCE(a.nome, 'Sem apresentadora') AS nome,
         COALESCE(a.nome, 'Sem apresentadora') AS apresentadora_nome,
         a.foto_url,
         a.foto_url AS apresentadora_foto_url,
         ${presenterFixedSql('a')} AS fixo,
         COALESCE(SUM(va.gmv), 0) AS gmv,
         COALESCE(SUM(CASE WHEN va.origem = 'live' THEN va.gmv ELSE 0 END), 0) AS gmv_lives,
         COALESCE(SUM(CASE WHEN va.origem = 'video' THEN va.gmv ELSE 0 END), 0) AS gmv_videos,
         COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'live')::int AS lives,
         COALESCE(SUM(va.pedidos), 0)::int AS pedidos,
         COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_variavel
       FROM apresentadoras a
       LEFT JOIN vendas_atribuidas va
         ON va.apresentadora_id = a.id
        AND va.tenant_id = a.tenant_id
        AND va.origem IN ('live', 'video')
        AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
        AND va.data >= $2::date
        AND va.data < $3::date
       WHERE a.tenant_id = $1::uuid
         AND a.ativo = true
       GROUP BY a.id, a.nome, a.foto_url, a.fixo
     )
     SELECT
       id,
       apresentadora_id,
       nome,
       apresentadora_nome,
       foto_url,
       apresentadora_foto_url,
       gmv,
       gmv_lives,
       gmv_videos,
       lives,
       pedidos,
       fixo,
       comissao_variavel,
       (fixo + comissao_variavel) AS total_recebido
     FROM ranking_apresentadoras_mes
     ORDER BY gmv DESC, total_recebido DESC, nome ASC
     LIMIT $4::int`,
    [tenantId, range.start, range.end, limit],
  )

  return mapPresenterRankingRows(result.rows, range.mes)
}
