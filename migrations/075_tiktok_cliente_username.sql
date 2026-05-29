-- migrations/075_tiktok_cliente_username.sql
-- W3-A: Adiciona @TikTok do cliente_parceiro como fallback ao tiktok_username do contrato.
-- O connector usa COALESCE(contratos.tiktok_username, clientes.tiktok_username) na live ativa.

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS tiktok_username TEXT;

CREATE INDEX IF NOT EXISTS clientes_tiktok_username_idx
  ON clientes(tenant_id, tiktok_username)
  WHERE tiktok_username IS NOT NULL;

-- Constraint de formato: 2-24 chars, somente letras/dígitos/underscore/ponto.
-- DROP IF EXISTS pra ser idempotente em re-runs.
ALTER TABLE clientes
  DROP CONSTRAINT IF EXISTS clientes_tiktok_username_format;
ALTER TABLE clientes
  ADD CONSTRAINT clientes_tiktok_username_format
  CHECK (tiktok_username IS NULL OR tiktok_username ~ '^[a-zA-Z0-9_.]{2,24}$');

-- Mesmo formato em contratos (já existe a coluna desde 021, mas sem CHECK).
ALTER TABLE contratos
  DROP CONSTRAINT IF EXISTS contratos_tiktok_username_format;
ALTER TABLE contratos
  ADD CONSTRAINT contratos_tiktok_username_format
  CHECK (tiktok_username IS NULL OR tiktok_username ~ '^[a-zA-Z0-9_.]{2,24}$');
