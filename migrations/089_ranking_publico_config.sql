ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS ranking_publico_ativo BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ranking_publico_nome TEXT,
  ADD COLUMN IF NOT EXISTS ranking_publico_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS ranking_publico_cidade TEXT,
  ADD COLUMN IF NOT EXISTS ranking_publico_uf TEXT,
  ADD COLUMN IF NOT EXISTS ranking_publico_meta_gmv NUMERIC(15,2);

CREATE INDEX IF NOT EXISTS idx_tenants_ranking_publico
  ON tenants (ranking_publico_ativo, nome);
