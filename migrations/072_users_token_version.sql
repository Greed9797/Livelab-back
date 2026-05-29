-- Migration 072: token_version em users — revogação imediata de JWTs.
--
-- Problema resolvido:
--   Após /v1/auth/redefinir-senha, refresh_tokens são revogados, mas os
--   access tokens (JWT, TTL 15min) emitidos ANTES do reset continuam válidos
--   por até 15 minutos. Janela de exposição se senha vazou.
--
-- Solução:
--   - Cada user tem um token_version (default 1).
--   - Ao emitir JWT (login/refresh), gravamos token_version no payload.
--   - app.authenticate compara JWT.token_version vs DB.token_version.
--     Se DB > JWT: 401 "Sessão expirada" (JWT antigo invalidado).
--   - /redefinir-senha e /usuarios/:id/force-logout incrementam token_version,
--     invalidando TODOS os JWTs anteriores instantaneamente.
--
-- Custo: 1 SELECT users.token_version por request autenticado. Negligível
-- (índice composto users(id, token_version) cobre a query).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS users_token_version_idx
  ON users(id, token_version);
