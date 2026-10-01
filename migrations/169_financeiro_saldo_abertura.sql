-- 169 — Financeiro: saldo de abertura + data de corte por tenant.
--
-- O financeiro começa "do zero" numa data de corte: o dono cadastra o saldo REAL
-- de caixa naquele dia (financeiro_saldo_abertura) e dali em diante lança despesas,
-- receitas e baixas. Regra de corte (src/services/financeiro-agregador.js,
-- dentroDoCorte): data efetiva do item = data_pagamento se valor_pago > 0, senão
-- data_vencimento; item com data efetiva < financeiro_data_corte fica FORA de
-- lançamentos, DRE, fluxo de caixa, totais e imposto. NULL = sem corte (nada muda).
-- Idempotente.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS financeiro_data_corte DATE NULL,
  ADD COLUMN IF NOT EXISTS financeiro_saldo_abertura NUMERIC(15,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN tenants.financeiro_data_corte IS
  'Início do financeiro: itens com data efetiva (pagamento se pago, senão vencimento) anterior a esta data são ignorados. NULL = sem corte.';
COMMENT ON COLUMN tenants.financeiro_saldo_abertura IS
  'Saldo real de caixa na data de corte (base de GET /v1/financeiro/caixa e do saldo inicial do fluxo de caixa).';
