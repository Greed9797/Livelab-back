-- 173 — Receita PERDIDA e despesa CANCELADA (encerramento sem pagamento).
--
-- Receita (receita_titulos do comercial e receitas_avulsas): perdido_em/motivo/por.
-- Custo (custos): cancelado_em/motivo/por. Só marcam o encerramento — o histórico
-- (valor_previsto, valor_pago, data_pagamento) é preservado e a linha nunca é apagada.
-- Status NUNCA é gravado — derivado em src/lib/lancamento-status.js
-- ('perdido' | 'cancelado'; pago tem precedência).
-- Desfazer = voltar os três campos para NULL. Idempotente (só ADD COLUMN IF NOT EXISTS).

ALTER TABLE receita_titulos  ADD COLUMN IF NOT EXISTS perdido_em     TIMESTAMPTZ NULL;
ALTER TABLE receita_titulos  ADD COLUMN IF NOT EXISTS perdido_motivo TEXT NULL;
ALTER TABLE receita_titulos  ADD COLUMN IF NOT EXISTS perdido_por    UUID NULL REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE receitas_avulsas ADD COLUMN IF NOT EXISTS perdido_em     TIMESTAMPTZ NULL;
ALTER TABLE receitas_avulsas ADD COLUMN IF NOT EXISTS perdido_motivo TEXT NULL;
ALTER TABLE receitas_avulsas ADD COLUMN IF NOT EXISTS perdido_por    UUID NULL REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE custos           ADD COLUMN IF NOT EXISTS cancelado_em     TIMESTAMPTZ NULL;
ALTER TABLE custos           ADD COLUMN IF NOT EXISTS cancelado_motivo TEXT NULL;
ALTER TABLE custos           ADD COLUMN IF NOT EXISTS cancelado_por    UUID NULL REFERENCES users(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receita_titulos_perdido_motivo_check') THEN
    ALTER TABLE receita_titulos ADD CONSTRAINT receita_titulos_perdido_motivo_check
      CHECK (perdido_motivo IS NULL OR char_length(perdido_motivo) <= 300);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receitas_avulsas_perdido_motivo_check') THEN
    ALTER TABLE receitas_avulsas ADD CONSTRAINT receitas_avulsas_perdido_motivo_check
      CHECK (perdido_motivo IS NULL OR char_length(perdido_motivo) <= 300);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custos_cancelado_motivo_check') THEN
    ALTER TABLE custos ADD CONSTRAINT custos_cancelado_motivo_check
      CHECK (cancelado_motivo IS NULL OR char_length(cancelado_motivo) <= 300);
  END IF;
END $$;

COMMENT ON COLUMN receita_titulos.perdido_em IS
  'Título dado como perdido (cliente não vai pagar). Encerra o saldo em aberto (previsto − pago); NULL = não perdido.';
COMMENT ON COLUMN receitas_avulsas.perdido_em IS
  'Receita avulsa dada como perdida. Encerra o saldo em aberto (previsto − pago); NULL = não perdida.';
COMMENT ON COLUMN custos.cancelado_em IS
  'Custo cancelado (não será pago: cancelado/perdoado/duplicado). Sai do a pagar e do previsto; NULL = ativo.';
