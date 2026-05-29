-- Migration 014: Produtos vendidos por live
CREATE TABLE live_products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id      UUID NOT NULL REFERENCES lives(id),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  produto_nome TEXT NOT NULL,
  quantidade   INTEGER DEFAULT 0,
  valor_unit   NUMERIC(15,2) DEFAULT 0,
  valor_total  NUMERIC(15,2) DEFAULT 0,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Habilitando RLS (Row Level Security) para garantir o isolamento por tenant
ALTER TABLE live_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY live_products_rls ON live_products
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
