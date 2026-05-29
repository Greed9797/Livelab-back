CREATE TABLE IF NOT EXISTS contratos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  cliente_id    UUID NOT NULL REFERENCES clientes(id),
  user_id       UUID NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'rascunho'
                  CHECK (status IN ('rascunho','enviado','em_analise','ativo','cancelado')),
  valor_fixo    NUMERIC(15,2) NOT NULL DEFAULT 0,
  comissao_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  de_risco      BOOLEAN NOT NULL DEFAULT false,
  assinado_em   TIMESTAMPTZ,
  ativado_em    TIMESTAMPTZ,
  cancelado_em  TIMESTAMPTZ,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contratos_tenant  ON contratos(tenant_id);
CREATE INDEX idx_contratos_cliente ON contratos(cliente_id);
CREATE INDEX idx_contratos_status  ON contratos(status);

ALTER TABLE contratos ENABLE ROW LEVEL SECURITY;
CREATE POLICY contratos_tenant ON contratos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
