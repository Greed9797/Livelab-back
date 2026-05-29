-- Migration: 023_billing_batch_setup
-- Adiciona suporte a faturamento em lote para as lives e controle de notificação no app

ALTER TABLE lives ADD COLUMN IF NOT EXISTS faturado_em TIMESTAMPTZ;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS boleto_id UUID REFERENCES boletos(id);

ALTER TABLE boletos ADD COLUMN IF NOT EXISTS notificado_em TIMESTAMPTZ;
