-- Migration 035: metadados de manuais (categoria, paginas, destaque) + seed
ALTER TABLE manuais
  ADD COLUMN IF NOT EXISTS categoria TEXT,
  ADD COLUMN IF NOT EXISTS paginas INTEGER,
  ADD COLUMN IF NOT EXISTS destaque BOOLEAN NOT NULL DEFAULT false;

-- Backfill de placeholders para os docs semeados no 011
UPDATE manuais SET categoria = 'Operação', paginas = 48,  destaque = true
  WHERE titulo = 'Manual de Operações LiveShop' AND categoria IS NULL;

UPDATE manuais SET categoria = 'Operação', paginas = 24,  destaque = true
  WHERE titulo = 'Guia de Configuração de Cabines' AND categoria IS NULL;

UPDATE manuais SET categoria = 'Equipe',   paginas = 32
  WHERE titulo = 'Treinamento de Apresentadores' AND categoria IS NULL;

UPDATE manuais SET categoria = 'Comercial', paginas = 18
  WHERE titulo = 'Manual de Vendas e Negociação' AND categoria IS NULL;

UPDATE manuais SET categoria = 'Legal',    paginas = 12
  WHERE titulo = 'Política de Franquia' AND categoria IS NULL;
