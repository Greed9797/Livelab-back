// Operational projection only. Never import this into commission or settlement
// calculations: submitted amounts are declarations, not payable sales.
export function pendingCollisionSql(alias = 's') {
  return `(EXISTS (SELECT 1 FROM lives pending_live
    WHERE pending_live.tenant_id=${alias}.tenant_id AND pending_live.marca_id=${alias}.marca_id
      AND pending_live.status IN ('encerrada','faturada')
      AND pending_live.iniciado_em < ${alias}.encerrado_em
      AND pending_live.encerrado_em > ${alias}.iniciado_em)
    OR EXISTS (SELECT 1 FROM apresentadora_live_submissoes pending_peer
      WHERE pending_peer.tenant_id=${alias}.tenant_id AND pending_peer.marca_id=${alias}.marca_id
        AND pending_peer.id<>${alias}.id AND pending_peer.status='pendente'
        AND pending_peer.iniciado_em < ${alias}.encerrado_em
        AND pending_peer.encerrado_em > ${alias}.iniciado_em))`
}

export function pendingRecord(row) {
  return {
    ...row, id: `submissao:${row.id}`, submissao_id: row.id,
    registro_tipo: 'submissao', status: 'encerrada', status_publicacao: 'rascunho',
    revisao_status: row.status, origem_dados: 'apresentadora',
    pendente_aprovacao: row.status === 'pendente',
    gmv: Number(row.gmv_declarado ?? 0), final_orders_count: row.pedidos_declarados,
    live_impressions: row.live_impressions_declaradas, manual_views: row.manual_views_declaradas,
    resumo: row.observacao, comissao_apresentadora: null,
  }
}

export async function pendingRows(db, { tenantId, start, end, apresentadoraId = null, marcaId = null, clienteId = null }) {
  const result = await db.query(`SELECT s.*, TRUE AS pendente_aprovacao,
      m.nome AS marca_nome,a.nome AS apresentadora_nome,c.nome AS cabine_nome,
      ${pendingCollisionSql()} AS em_conciliacao
    FROM apresentadora_live_submissoes s
    LEFT JOIN marcas m ON m.id=s.marca_id AND m.tenant_id=s.tenant_id
    LEFT JOIN apresentadoras a ON a.id=s.apresentadora_id AND a.tenant_id=s.tenant_id
    LEFT JOIN cabines c ON c.id=s.cabine_id AND c.tenant_id=s.tenant_id
    WHERE s.tenant_id=$1::uuid AND s.status='pendente'
      AND s.iniciado_em >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND s.iniciado_em < ($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND ($4::uuid IS NULL OR s.apresentadora_id=$4::uuid)
      AND ($5::uuid IS NULL OR s.marca_id=$5::uuid)
      AND ($6::uuid IS NULL OR m.cliente_id=$6::uuid)
    ORDER BY s.iniciado_em,s.id`, [tenantId,start,end,apresentadoraId,marcaId,clienteId])
  return result.rows
}
