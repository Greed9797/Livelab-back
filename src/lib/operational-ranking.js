import { getPerformanceRanking } from './performance-rollups.js'
import { pendingRows } from './presenter-pending.js'
import { presenterFixedAtSql } from '../config/presenter_defaults.js'

// Financial routes keep getPerformanceRanking. This wrapper is exclusively
// for operational dashboards, where declarations must remain visible.
export async function getOperationalRanking(db, options) {
  const rows = await getPerformanceRanking(db, { ...options, limit: 2147483647 })
  if (options.origem === 'video') return rows.slice(0, options.limit ?? 50)
  const declarations = await pendingRows(db, { tenantId: options.tenantId,
    start: options.range.start, end: options.range.end, marcaId: options.marcaId,
    apresentadoraId: options.apresentadoraId, clienteId: options.clienteId })
  const key = options.groupBy === 'marca' ? 'marca_id' : 'apresentadora_id'
  const pendingOnlyPresenters = []
  const byId = new Map(rows.map(row => [row[key], { ...row, gmv_validado: row.gmv_lives,
    gmv_pendente_aprovacao: 0, total_lives_pendentes_aprovacao: 0, em_conciliacao: false }]))
  for (const item of declarations) {
    // Defensive DTO check also prevents unrelated rows from mock adapters.
    if (item.pendente_aprovacao !== true) continue
    const id = item[key]
    let row = byId.get(id)
    if (!row) {
      row = { id, [key]: id, nome: item[key === 'marca_id' ? 'marca_nome' : 'apresentadora_nome'],
        marca_nome: item.marca_nome, apresentadora_nome: item.apresentadora_nome,
        gmv: 0, gmv_total: 0, gmv_lives: 0, gmv_videos: 0, gmv_validado: 0,
        horas_live: 0, pedidos: 0, total_lives: 0, total_videos: 0,
        fixo: null, total_recebido: null,
        gmv_pendente_aprovacao: 0, total_lives_pendentes_aprovacao: 0,
        comissao_variavel: 0, comissao_apresentadora: 0, comissao_franquia: 0, comissao_franqueadora: 0 }
      byId.set(id, row)
      if (key === 'apresentadora_id') pendingOnlyPresenters.push(id)
    }
    row.gmv_pendente_aprovacao += Number(item.gmv_declarado ?? 0)
    row.total_lives_pendentes_aprovacao++
    row.em_conciliacao ||= Boolean(item.em_conciliacao)
    if (item.em_conciliacao) continue
    const gmv = Number(item.gmv_declarado ?? 0)
    row.gmv_lives += gmv; row.gmv_total += gmv; row.gmv = row.gmv_total
    row.pedidos += Number(item.pedidos_declarados ?? 0)
    row.horas_live += Math.max(0, (new Date(item.encerrado_em)-new Date(item.iniciado_em))/3600000)
    row.total_lives++
  }
  if (pendingOnlyPresenters.length) {
    // Preserve the existing contractual fixed amount in new ranking entries.
    // Declared results do not create or change payable commissions.
    const fixed = await db.query(`SELECT a.id, a.foto_url, ${presenterFixedAtSql('a', '($3::date - 1)')} AS fixo
      FROM apresentadoras a WHERE a.tenant_id=$1::uuid AND a.id=ANY($2::uuid[])`,
    [options.tenantId, pendingOnlyPresenters, options.range.end])
    for (const item of fixed.rows) {
      const row = byId.get(item.id)
      if (row) Object.assign(row, { fixo: Number(item.fixo), total_recebido: Number(item.fixo), foto_url: item.foto_url, apresentadora_foto_url: item.foto_url })
    }
  }
  return [...byId.values()].map(row => ({ ...row,
    pendente_aprovacao: row.total_lives_pendentes_aprovacao > 0,
    total_provisorio: row.em_conciliacao ? null : row.gmv_total,
    pedidos_total: row.pedidos, lives: row.total_lives,
    gmv_por_hora: row.horas_live > 0 ? row.gmv_lives / row.horas_live : 0,
  })).sort((a,b) => b.gmv_total-a.gmv_total || String(a.id).localeCompare(String(b.id))).slice(0, options.limit ?? 50)
}
