CREATE TABLE IF NOT EXISTS clientes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  nome          TEXT NOT NULL,
  cpf           TEXT,
  cnpj          TEXT,
  razao_social  TEXT,
  email         TEXT,
  celular       TEXT NOT NULL,
  fat_anual     NUMERIC(15,2) DEFAULT 0,
  nicho         TEXT,
  site          TEXT,
  vende_tiktok  BOOLEAN DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'negociacao'
                  CHECK (status IN ('negociacao','enviado','em_analise','ativo','inadimplente','cancelado')),
  lat           NUMERIC(10,7),
  lng           NUMERIC(10,7),
  score         INTEGER DEFAULT 0,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clientes_tenant ON clientes(tenant_id);
CREATE INDEX idx_clientes_status ON clientes(status);

ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY clientes_tenant ON clientes
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
