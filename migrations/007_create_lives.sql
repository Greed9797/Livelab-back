CREATE TABLE IF NOT EXISTS lives (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  cabine_id           UUID NOT NULL REFERENCES cabines(id),
  cliente_id          UUID NOT NULL REFERENCES clientes(id),
  apresentador_id     UUID NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'em_andamento'
                        CHECK (status IN ('em_andamento','encerrada','cancelada')),
  iniciado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  encerrado_em        TIMESTAMPTZ,
  fat_gerado          NUMERIC(15,2) DEFAULT 0,
  comissao_calculada  NUMERIC(15,2) DEFAULT 0
);

CREATE INDEX idx_lives_tenant       ON lives(tenant_id);
CREATE INDEX idx_lives_cabine       ON lives(cabine_id);
CREATE INDEX idx_lives_apresentador ON lives(apresentador_id);

ALTER TABLE lives ENABLE ROW LEVEL SECURITY;
CREATE POLICY lives_tenant ON lives
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
