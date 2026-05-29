-- Add pacote_id, horas_contratadas, horas_consumidas to contratos
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS pacote_id UUID REFERENCES pacotes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS horas_contratadas NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS horas_consumidas NUMERIC(10,2) DEFAULT 0;
