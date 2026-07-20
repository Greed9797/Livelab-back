-- Cor manual da marca (hex '#rrggbb'). NULL = cor automática (hash determinístico no front).
ALTER TABLE marcas ADD COLUMN IF NOT EXISTS cor CHAR(7);
