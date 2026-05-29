-- Telefone e e-mail de contato do franqueado no tenant
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS telefone_contato TEXT,
  ADD COLUMN IF NOT EXISTS email_contato    TEXT;

-- Histórico de alterações de telefone/e-mail
CREATE TABLE IF NOT EXISTS tenant_contact_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  alterado_por   UUID REFERENCES users(id),
  campo          TEXT NOT NULL CHECK (campo IN ('telefone', 'email')),
  valor_anterior TEXT,
  valor_novo     TEXT,
  alterado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_history_tenant
  ON tenant_contact_history(tenant_id, alterado_em DESC);

-- Meta diária por cliente (mesma mecânica da franquia e da apresentadora)
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS meta_diaria_gmv NUMERIC(15,2) NOT NULL DEFAULT 0;

-- Apresentadora vinculada a agendamentos
ALTER TABLE live_requests
  ADD COLUMN IF NOT EXISTS apresentadora_id UUID REFERENCES apresentadoras(id);
