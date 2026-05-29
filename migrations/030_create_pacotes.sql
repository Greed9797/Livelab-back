CREATE TABLE IF NOT EXISTS pacotes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  nome             TEXT NOT NULL,
  descricao        TEXT,
  valor            NUMERIC(15,2) NOT NULL DEFAULT 0,
  horas_incluidas  NUMERIC(10,2) NOT NULL DEFAULT 0,
  ativo            BOOLEAN NOT NULL DEFAULT true,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pacotes_tenant ON pacotes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pacotes_ativo  ON pacotes(tenant_id, ativo);

ALTER TABLE pacotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY pacotes_tenant ON pacotes
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
