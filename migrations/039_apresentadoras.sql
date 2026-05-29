CREATE TABLE IF NOT EXISTS apresentadoras (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  nome            TEXT NOT NULL,
  telefone        TEXT,
  cargo           TEXT,
  email           TEXT,
  cpf_cnpj        TEXT,
  cidade          TEXT,
  ativo           BOOLEAN NOT NULL DEFAULT true,
  fixo            NUMERIC(15,2) NOT NULL DEFAULT 0,
  comissao_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
  meta_diaria_gmv NUMERIC(15,2) NOT NULL DEFAULT 0,
  observacoes     TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apresentadoras_tenant ON apresentadoras(tenant_id);
CREATE INDEX IF NOT EXISTS idx_apresentadoras_ativo   ON apresentadoras(tenant_id, ativo);

ALTER TABLE apresentadoras ENABLE ROW LEVEL SECURITY;
CREATE POLICY apresentadoras_tenant ON apresentadoras
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
