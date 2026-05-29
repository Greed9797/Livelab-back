-- Adiciona coluna deleted_at para soft-delete em clientes
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
