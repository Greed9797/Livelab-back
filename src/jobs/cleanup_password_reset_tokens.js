// Job: cleanup_password_reset_tokens
//
// Remove tokens de reset de senha antigos da tabela password_reset_tokens.
// Sem cleanup, a tabela cresce eternamente (cada /esqueci-senha grava 1 row).
//
// Critério: criado_em < NOW() - INTERVAL '30 days'.
// Cobre tanto tokens já consumidos quanto expirados há tempo — após 30 dias
// não há valor forense em manter (ip_solicitacao já investigado se relevante).
//
// Roda via cron diário às 03:00 BR. Usa app.db direto (sem RLS — tabela system).

export async function cleanupPasswordResetTokens(app) {
  try {
    const result = await app.db.query(
      `DELETE FROM password_reset_tokens
        WHERE criado_em < NOW() - INTERVAL '30 days'`
    )
    const deleted = result.rowCount ?? 0
    if (deleted > 0) {
      app.log.info({ deleted }, '[cleanup_password_reset_tokens] tokens removidos')
    } else {
      app.log.debug('[cleanup_password_reset_tokens] nenhum token elegível')
    }
    return deleted
  } catch (err) {
    app.log.error({ err }, '[cleanup_password_reset_tokens] falha ao limpar tokens')
    return 0
  }
}
