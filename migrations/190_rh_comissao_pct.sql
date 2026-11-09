ALTER TABLE rh_colaboradores
  ADD COLUMN IF NOT EXISTS comissao_pct NUMERIC(5,2) NOT NULL DEFAULT 0
  CHECK (comissao_pct >= 0 AND comissao_pct <= 100);
