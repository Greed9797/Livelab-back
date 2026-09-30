-- 168 — Conciliação Asaas com baixa automática.
-- 1) conciliado_com_tipo passa a aceitar apresentadora (apresentadora_pagamentos.id) e
--    imposto (custos.id, tipo 'imposto'); o vínculo guarda sempre o UUID REAL do alvo
--    (ids virtuais calc:/rec:/imposto: são materializados na mesma transação da baixa).
-- 2) conciliado_baixa = true quando a baixa do alvo foi GERADA pela conciliação;
--    desconciliar só desfaz baixas com essa marca (nunca uma baixa manual).
-- Idempotente.

ALTER TABLE gateway_transacoes
  ADD COLUMN IF NOT EXISTS conciliado_baixa BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE gateway_transacoes DROP CONSTRAINT IF EXISTS gateway_transacoes_conciliado_com_tipo_check;
ALTER TABLE gateway_transacoes DROP CONSTRAINT IF EXISTS chk_gateway_transacoes_tipo_alvo;
ALTER TABLE gateway_transacoes
  ADD CONSTRAINT chk_gateway_transacoes_tipo_alvo
  CHECK (conciliado_com_tipo IS NULL
         OR conciliado_com_tipo IN ('receita', 'custo', 'apresentadora', 'imposto'));
