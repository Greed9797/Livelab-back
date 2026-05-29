CREATE TABLE IF NOT EXISTS custos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  descricao   TEXT NOT NULL,
  valor       NUMERIC(15,2) NOT NULL,
  tipo        TEXT NOT NULL CHECK (tipo IN ('aluguel','salario','energia','internet','outros')),
  competencia DATE NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_custos_tenant      ON custos(tenant_id);
CREATE INDEX idx_custos_competencia ON custos(competencia);

ALTER TABLE custos ENABLE ROW LEVEL SECURITY;
CREATE POLICY custos_tenant ON custos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
