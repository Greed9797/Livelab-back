-- Extensão das métricas manuais: comentários, shares, diamantes
ALTER TABLE lives ADD COLUMN IF NOT EXISTS manual_comments  INTEGER;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS manual_shares    INTEGER;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS manual_diamonds  INTEGER;
