-- 167 — Imposto do financeiro: alíquota por tenant (default 10%) + baixa materializada.
--
-- Regra (SPEC v2 / onda 2): base = total RECEBIDO de receitas (receita_titulos.valor_pago
-- por data_pagamento) no mês M-1; imposto lançado na competência M, vencendo dia 20 de M.
-- O valor previsto NÃO é gravado enquanto não houver baixa: é calculado em
-- src/services/financeiro-agregador.js. A baixa materializa uma linha em `custos`
-- (tipo 'imposto', uma por tenant × competência). Status é sempre derivado.
-- Idempotente.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS aliquota_imposto_pct NUMERIC(5,2) NOT NULL DEFAULT 10;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_aliquota_imposto_pct_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_aliquota_imposto_pct_check
      CHECK (aliquota_imposto_pct >= 0 AND aliquota_imposto_pct <= 100);
  END IF;
END $$;

COMMENT ON COLUMN tenants.aliquota_imposto_pct IS
  'Alíquota (%) do imposto sobre o recebido no mês anterior. Default 10. Editável em PATCH /v1/financeiro/config.';

-- No máximo UM imposto materializado por tenant × competência.
CREATE UNIQUE INDEX IF NOT EXISTS idx_custos_imposto_competencia
  ON custos(tenant_id, competencia) WHERE tipo = 'imposto';
