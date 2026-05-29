CREATE TABLE IF NOT EXISTS recomendacoes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  nome_indicado   TEXT NOT NULL,
  recomendante    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente','convertido','descartado')),
  lat             NUMERIC(10,7),
  lng             NUMERIC(10,7),
  convertido_em   TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recomendacoes_tenant ON recomendacoes(tenant_id);
CREATE INDEX idx_recomendacoes_status ON recomendacoes(status);

ALTER TABLE recomendacoes ENABLE ROW LEVEL SECURITY;
CREATE POLICY recomendacoes_tenant ON recomendacoes
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
