-- Coluna estruturada pra dados extras do formulário (capital, situacao, atrativos, etc).
-- JSONB indexado via GIN pra suportar filtros tipo `dados_extras->>'capital'` no CRM.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS dados_extras JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_leads_dados_extras ON leads USING GIN (dados_extras);
