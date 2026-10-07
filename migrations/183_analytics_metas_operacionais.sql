-- Aditiva: não altera metas mensais, comissões ou registros existentes.
ALTER TABLE meta_unidade ADD COLUMN IF NOT EXISTS configuracao_operacional JSONB;
ALTER TABLE metas_apresentadora ADD COLUMN IF NOT EXISTS meta_gmv_hora NUMERIC(15,2);
COMMENT ON COLUMN meta_unidade.configuracao_operacional IS
  'Parâmetros de capacidade e equipe de referência da competência. NULL = não configurado.';
COMMENT ON COLUMN metas_apresentadora.meta_gmv_hora IS
  'Piso operacional por hora de presença em lives; NULL herda piso da unidade. Não substitui gmv_meta.';
