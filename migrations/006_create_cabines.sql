CREATE TABLE IF NOT EXISTS cabines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  numero        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'disponivel'
                  CHECK (status IN ('ao_vivo','disponivel','manutencao')),
  live_atual_id UUID,
  UNIQUE (tenant_id, numero)
);

CREATE INDEX idx_cabines_tenant ON cabines(tenant_id);

ALTER TABLE cabines ENABLE ROW LEVEL SECURITY;
CREATE POLICY cabines_tenant ON cabines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Seed 10 cabines para o tenant de desenvolvimento
INSERT INTO cabines (tenant_id, numero, status)
SELECT '00000000-0000-0000-0000-000000000001', g,
  CASE WHEN g <= 3 THEN 'ao_vivo' ELSE 'disponivel' END
FROM generate_series(1, 10) g;
