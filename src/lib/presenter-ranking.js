import { getPerformanceRanking } from './performance-rollups.js'

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
  const rows = await getPerformanceRanking(db, {
    tenantId,
    range,
    limit,
    groupBy: 'apresentadora',
  })

  return mapPresenterRankingRows(rows, range.mes)
}
