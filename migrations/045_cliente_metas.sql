CREATE TABLE IF NOT EXISTS cliente_metas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  ano INTEGER NOT NULL,
  mes INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  meta_gmv NUMERIC(12,2) NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cliente_id, ano, mes)
);
CREATE INDEX IF NOT EXISTS idx_cliente_metas_cliente_id ON cliente_metas(cliente_id);
