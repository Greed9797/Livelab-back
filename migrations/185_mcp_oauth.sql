-- Aditiva: não altera usuários, regras financeiras nem dados operacionais.
CREATE TABLE IF NOT EXISTS mcp_oauth_artifacts (
  model text NOT NULL,
  id_hash text NOT NULL,
  payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  grant_hash text,
  uid_hash text,
  user_code_hash text,
  PRIMARY KEY (model, id_hash)
);
CREATE INDEX IF NOT EXISTS mcp_oauth_artifacts_grant_idx ON mcp_oauth_artifacts (grant_hash);
CREATE INDEX IF NOT EXISTS mcp_oauth_artifacts_uid_idx ON mcp_oauth_artifacts (model, uid_hash);
CREATE INDEX IF NOT EXISTS mcp_oauth_artifacts_expiry_idx ON mcp_oauth_artifacts (expires_at);
CREATE TABLE IF NOT EXISTS mcp_oauth_bindings (
  grant_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_version integer NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT NOW()
);
-- Artefatos globais de autenticação: nenhum papel tenant recebe acesso.
REVOKE ALL ON mcp_oauth_artifacts, mcp_oauth_bindings FROM PUBLIC;
