/**
 * Snapshot da comissão da apresentadora por live (lives.comissao_apresentadora_valor / _pct).
 *
 * Fonte única é o motor: vendas_atribuidas (commission-engine + faixas). O snapshot existe para
 * leitura barata em telas que agregam por live (painel do cliente, relatório operacional) e
 * DEVE ser derivado do motor, nunca calculado à parte — em 2026-09-04 ele era recalculado com
 * apresentadoras.comissao_pct chapado e mostrava "—" em 571 de 624 lives enquanto o Financeiro
 * mostrava valor em 497. Todo escritor de vendas_atribuidas (origem='live') chama isto ao fim.
 */

/**
 * Recalcula o snapshot das lives informadas a partir de vendas_atribuidas.
 * Live sem venda atribuída não é tocada (o UPDATE ... FROM só casa quem tem agregado).
 *
 * @param {{ query: Function }} db  conexão com tenant configurado
 * @param {{ tenantId: string, liveIds: Array<string | null | undefined> }} params
 * @returns {Promise<number>} lives atualizadas
 */
export async function sincronizarSnapshotComissaoApresentadora(db, { tenantId, liveIds }) {
  const ids = [...new Set((liveIds ?? []).filter(Boolean))]
  if (!tenantId || ids.length === 0) return 0
  const result = await db.query(
    `UPDATE lives l
        SET comissao_apresentadora_valor = agg.valor,
            comissao_apresentadora_pct   = agg.pct
       FROM (
         SELECT origem_id AS live_id,
                SUM(comissao_apresentadora) AS valor,
                ROUND(SUM(comissao_apresentadora) / NULLIF(SUM(gmv), 0) * 100, 2) AS pct
           FROM vendas_atribuidas
          WHERE tenant_id = $1::uuid
            AND origem = 'live'
            AND origem_id = ANY($2::uuid[])
          GROUP BY origem_id
       ) agg
      WHERE l.id = agg.live_id
        AND l.tenant_id = $1::uuid`,
    [tenantId, ids],
  )
  return result?.rowCount ?? 0
}
