-- Separate fixed minimum from variable commission in packages
ALTER TABLE pacotes
  ADD COLUMN IF NOT EXISTS valor_fixo   NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comissao_pct NUMERIC(5,2)  NOT NULL DEFAULT 0;

-- Backfill: existing "valor" becomes "valor_fixo"
UPDATE pacotes SET valor_fixo = valor WHERE valor_fixo = 0 AND valor > 0;
