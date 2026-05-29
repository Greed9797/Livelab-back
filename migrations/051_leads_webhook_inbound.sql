-- Suporte a leads vindos de webhook externo (form bio do site público)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS payload_externo JSONB,
  ADD COLUMN IF NOT EXISTS contato_email TEXT,
  ADD COLUMN IF NOT EXISTS contato_whatsapp TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_origem ON leads(origem) WHERE origem IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_contato_email ON leads(contato_email) WHERE contato_email IS NOT NULL;
