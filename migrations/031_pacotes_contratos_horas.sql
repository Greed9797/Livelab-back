-- Link pacote to contratos
ALTER TABLE contratos ADD COLUMN IF NOT EXISTS pacote_id UUID REFERENCES pacotes(id);

-- Track remaining live hours per client
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS horas_saldo NUMERIC(10,2) NOT NULL DEFAULT 0;
