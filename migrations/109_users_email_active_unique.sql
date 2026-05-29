-- Causa raiz: índice UNIQUE (LOWER(email), tenant_id) da migration 056 não
-- filtra por `ativo`. Após soft-delete (ativo=false) o email continuava
-- bloqueando reuso, mas o GET /v1/usuarios não mostra inativos — admin não
-- via o conflito e o POST /v1/usuarios/convidar caía em 409 surpresa.
--
-- Fix: substituir por índice UNIQUE parcial que só considera usuários ativos.
-- Soft-deletados continuam no banco (audit/restore), mas o email volta a
-- ser reutilizável.

DROP INDEX IF EXISTS users_email_tenant_unique;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_tenant_active_unique
  ON users (LOWER(email), tenant_id)
  WHERE ativo IS NOT FALSE;

-- Índice não-único pra busca de soft-deletados (audit, restore manual).
CREATE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (LOWER(email));
