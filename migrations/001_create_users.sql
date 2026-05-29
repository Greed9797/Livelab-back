-- Extensão para UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tabela de tenants (franqueadoras e franqueados)
CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        TEXT NOT NULL,
  ativo       BOOLEAN NOT NULL DEFAULT true,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Usuários multitenant
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  nome        TEXT NOT NULL,
  email       TEXT NOT NULL,
  senha_hash  TEXT NOT NULL,
  papel       TEXT NOT NULL CHECK (papel IN ('franqueador_master','franqueado','cliente_parceiro')),
  ativo       BOOLEAN NOT NULL DEFAULT true,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email   ON users(email);

-- RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant ON users
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Seed: tenant e usuário admin para desenvolvimento
INSERT INTO tenants (id, nome) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Franqueadora Master');

-- senha: admin123 (bcrypt hash gerado em node: bcrypt.hashSync('admin123', 10))
INSERT INTO users (tenant_id, nome, email, senha_hash, papel) VALUES
  ('00000000-0000-0000-0000-000000000001',
   'Admin Master',
   'admin@liveshop.com',
   '$2b$10$rOzJqJwQ2U3kL9X1nF4H3eTm8ZvKpAoGdHbNsYqWcXlDf6RkMiJe2',
   'franqueador_master');
