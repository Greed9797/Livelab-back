ALTER TABLE cabines ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_cabines_ativo ON cabines(tenant_id, ativo);
