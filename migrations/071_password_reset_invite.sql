-- Migration 071: password reset tokens + invite token columns on users.
-- F4: recuperação de senha + fluxo de convite com e-mail.
--
-- password_reset_tokens
--   token_hash: SHA256(token plaintext) — token plaintext NUNCA é gravado.
--   expira_em: TTL curto (1h padrão).
--   usado_em: marca de consumo (token single-use). Comparado em UPDATE atômico
--             (ver auth.js) para evitar race condition.
--   ip_solicitacao: forense — quem pediu o reset.
--
-- users.invite_token_hash: tokens de convite (TTL 72h). Mesma lógica de hash.
-- users.primeiro_acesso: barra reuso de link de convite após ativação
--   (anti account takeover).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  expira_em       TIMESTAMPTZ NOT NULL,
  usado_em        TIMESTAMPTZ,
  ip_solicitacao  TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
  ON password_reset_tokens(user_id);

-- Index parcial: apenas tokens ativos (não usados). Acelera lookup do worker
-- de cleanup e da query de consumo.
CREATE INDEX IF NOT EXISTS password_reset_tokens_active_idx
  ON password_reset_tokens(expira_em) WHERE usado_em IS NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invite_token_hash TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS invite_expira_em  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS primeiro_acesso   BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS users_invite_token_idx
  ON users(invite_token_hash) WHERE invite_token_hash IS NOT NULL;
