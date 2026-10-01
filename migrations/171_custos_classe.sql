-- 171 — Classe do custo (fixo | variável): override opcional.
--
-- A classe é DERIVADA em src/lib/custo-classe.js (classeDoItem): fixo = origem
-- recorrente | parcela | apresentadora (componente 'fixo'); variável = manual pontual |
-- apresentadora (componente 'variavel') | imposto. Estas colunas só guardam um OVERRIDE
-- explícito do usuário; NULL = usar a regra derivada. Em `custos`, o override do
-- próprio lançamento prevalece sobre o do recorrente de origem (custos_recorrentes).
-- Idempotente.

ALTER TABLE custos             ADD COLUMN IF NOT EXISTS classe_custo TEXT NULL;
ALTER TABLE custos_recorrentes ADD COLUMN IF NOT EXISTS classe_custo TEXT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custos_classe_custo_check') THEN
    ALTER TABLE custos ADD CONSTRAINT custos_classe_custo_check
      CHECK (classe_custo IS NULL OR classe_custo IN ('fixo', 'variavel'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custos_recorrentes_classe_custo_check') THEN
    ALTER TABLE custos_recorrentes ADD CONSTRAINT custos_recorrentes_classe_custo_check
      CHECK (classe_custo IS NULL OR classe_custo IN ('fixo', 'variavel'));
  END IF;
END $$;

COMMENT ON COLUMN custos.classe_custo IS
  'Override da classe (fixo|variavel). NULL = derivada da origem (src/lib/custo-classe.js).';
COMMENT ON COLUMN custos_recorrentes.classe_custo IS
  'Override da classe (fixo|variavel) herdado pelos lançamentos do recorrente. NULL = fixo (derivado).';
