-- Adiciona campos de contato operacional ao tenant
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS telefone_contato TEXT,
  ADD COLUMN IF NOT EXISTS email_contato TEXT;
