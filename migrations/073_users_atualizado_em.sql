-- Migration 073: users.atualizado_em — coluna usada por auth.js e usuarios.js.
--
-- Problema resolvido:
--   Várias rotas (auth.js linhas 170/346/398; usuarios.js linha 316) executam
--   `UPDATE users SET ..., atualizado_em = NOW()`, mas a coluna nunca foi
--   adicionada ao schema. Isso quebra silenciosamente:
--     - POST /v1/auth/redefinir-senha     (reset via token)
--     - POST /v1/auth/aceitar-convite     (ativação de conta convidada)
--     - POST /v1/auth/senha               (troca de senha logado)
--     - POST /v1/usuarios/:id/force-logout
--
-- Solução: ADD COLUMN IF NOT EXISTS (idempotente). Default NOW() para registros
-- existentes mantém ordering coerente.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Trigger BEFORE UPDATE não foi adicionado intencionalmente — as rotas que
-- atualizam senha/papel/ativo já gravam atualizado_em explicitamente. Trigger
-- automático aumenta o cost de UPDATEs em massa (ex: revoke de refresh_tokens)
-- sem ganho real, já que essas tabelas têm seu próprio campo de revogação.
