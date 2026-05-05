-- S-02: drop UNIQUE global em users.email (vazava enumeração cross-tenant)
-- e cria UNIQUE composto (email, tenant_id). Email pode repetir entre tenants.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
DROP INDEX IF EXISTS users_email_key;
DROP INDEX IF EXISTS idx_users_email;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_tenant_unique
  ON users (LOWER(email), tenant_id);

-- Mantém índice de busca por email pra auth (login resolve tenant pelo email + senha)
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));
