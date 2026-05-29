-- 092_tenants_atualizado_em.sql
-- Adiciona coluna atualizado_em em tenants (faltava — quebrava PATCH /v1/configuracoes/ranking-publico).
-- Idempotente.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Trigger para manter atualizado_em sincronizado em qualquer UPDATE
CREATE OR REPLACE FUNCTION trg_tenants_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_set_atualizado_em ON tenants;
CREATE TRIGGER tenants_set_atualizado_em
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION trg_tenants_atualizado_em();

INSERT INTO schema_migrations (version) VALUES ('092_tenants_atualizado_em.sql')
ON CONFLICT (version) DO NOTHING;
