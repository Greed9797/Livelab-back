CREATE TABLE IF NOT EXISTS boletos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  tipo               TEXT NOT NULL CHECK (tipo IN ('imposto','royalties','marketing','outros')),
  valor              NUMERIC(15,2) NOT NULL,
  vencimento         DATE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pendente'
                       CHECK (status IN ('pendente','pago','vencido')),
  pago_em            TIMESTAMPTZ,
  referencia_externa TEXT,
  competencia        DATE NOT NULL,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_boletos_tenant     ON boletos(tenant_id);
CREATE INDEX idx_boletos_vencimento ON boletos(vencimento);
CREATE INDEX idx_boletos_status     ON boletos(status);

ALTER TABLE boletos ENABLE ROW LEVEL SECURITY;
CREATE POLICY boletos_tenant ON boletos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
