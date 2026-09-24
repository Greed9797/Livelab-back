-- A lista do gestor esconde a live sem apagar GMV nem vendas_atribuidas.
-- 160 é a última entrada de apply_migrations.js neste branch; 161 não existia.
ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS arquivada_em TIMESTAMPTZ;

COMMENT ON COLUMN lives.arquivada_em IS
  'Quando preenchido, a live sai da lista do gestor. Não zera GMV nem apaga comissão.';

CREATE INDEX IF NOT EXISTS idx_lives_lista_gestor
  ON lives (tenant_id, iniciado_em DESC)
  WHERE arquivada_em IS NULL;
