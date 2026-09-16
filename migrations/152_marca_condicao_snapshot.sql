-- Migration 152 — identifica a condição comercial usada por cada atribuição.
-- Linhas antigas ficam NULL de propósito: seus valores já persistidos são
-- snapshots legados e não podem receber uma condição histórica inferida.
ALTER TABLE vendas_atribuidas
  ADD COLUMN IF NOT EXISTS marca_condicao_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vendas_atribuidas_marca_condicao_fk'
       AND conrelid = 'public.vendas_atribuidas'::regclass
  ) THEN
    ALTER TABLE vendas_atribuidas
      ADD CONSTRAINT vendas_atribuidas_marca_condicao_fk
      FOREIGN KEY (marca_condicao_id)
      REFERENCES marca_condicoes_comerciais(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS vendas_atribuidas_marca_condicao_idx
  ON vendas_atribuidas (tenant_id, marca_id, marca_condicao_id)
  WHERE marca_condicao_id IS NOT NULL;

COMMENT ON COLUMN vendas_atribuidas.marca_condicao_id IS
  'Condição comercial temporal resolvida na data da atribuição; NULL identifica snapshot legado não verificado.';
