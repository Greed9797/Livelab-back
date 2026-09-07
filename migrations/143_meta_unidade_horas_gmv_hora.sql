-- Metas operacionais opcionais, por unidade e competência.
-- meta_gmv permanece intacta: ela já alimenta o objetivo mensal legado da Home.
-- NULL representa "meta ainda não definida"; não há defaults arbitrários.

ALTER TABLE meta_unidade
  ADD COLUMN IF NOT EXISTS meta_horas_live NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS meta_gmv_hora NUMERIC(15,2);

-- As constraints são aditivas e aceitam as linhas existentes (NULL). Mantêm
-- a mesma regra de entrada da API também para escrita administrativa direta.
ALTER TABLE meta_unidade
  DROP CONSTRAINT IF EXISTS meta_unidade_meta_horas_live_nao_negativa,
  ADD CONSTRAINT meta_unidade_meta_horas_live_nao_negativa
    CHECK (meta_horas_live IS NULL OR meta_horas_live >= 0),
  DROP CONSTRAINT IF EXISTS meta_unidade_meta_gmv_hora_nao_negativa,
  ADD CONSTRAINT meta_unidade_meta_gmv_hora_nao_negativa
    CHECK (meta_gmv_hora IS NULL OR meta_gmv_hora >= 0);
