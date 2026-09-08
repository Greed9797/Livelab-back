// Runs inside the manager's live-delete transaction. The approved decision is
// immutable: only its physical live FK is cleared after a tombstone and an
// audit snapshot have both been persisted.
export async function tombstoneApprovedSubmissionsForDeletedLive(db, { tenantId, liveId, actorId }) {
  const changed = await db.query(
    `UPDATE apresentadora_live_submissoes
        SET live_oficial_excluida_id = live_oficial_id,
            live_oficial_excluida_em = NOW(),
            live_oficial_id = NULL,
            atualizado_em = NOW(),
            versao = versao + 1
      WHERE tenant_id = $1::uuid
        AND live_oficial_id = $2::uuid
        AND status = 'aprovada'
      RETURNING id, versao`,
    [tenantId, liveId],
  )

  for (const row of changed.rows) {
    await db.query(
      `INSERT INTO apresentadora_live_submissao_historico
          (tenant_id, submissao_id, versao, acao, ator_id, snapshot)
       SELECT $1::uuid, s.id, $3, 'live_oficial_excluida', $4::uuid,
              jsonb_build_object(
                'status', s.status,
                'live_oficial_id', s.live_oficial_id,
                'live_oficial_excluida_id', s.live_oficial_excluida_id,
                'live_oficial_excluida_em', s.live_oficial_excluida_em,
                'revisado_por', s.revisado_por,
                'revisado_em', s.revisado_em
              )
         FROM apresentadora_live_submissoes s
        WHERE s.id = $2::uuid
          AND s.tenant_id = $1::uuid`,
      [tenantId, row.id, row.versao, actorId],
    )
  }

  return changed.rows
}
