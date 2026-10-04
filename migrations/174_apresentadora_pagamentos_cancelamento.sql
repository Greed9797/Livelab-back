-- 174 — Cancelamento de pagamento de apresentadora (encerramento sem pagamento).
--
-- Mesmo modelo da 173 (custos): cancelado_em/motivo/por marcam o encerramento; status
-- 'cancelado' é derivado (src/lib/lancamento-status.js), nunca gravado. Linha cancelada sem
-- baixa = valor_pago 0 e data_pagamento NULL, por isso data_pagamento passa a aceitar NULL.
-- Idempotente.

ALTER TABLE apresentadora_pagamentos ADD COLUMN IF NOT EXISTS cancelado_em     TIMESTAMPTZ NULL;
ALTER TABLE apresentadora_pagamentos ADD COLUMN IF NOT EXISTS cancelado_motivo TEXT NULL;
ALTER TABLE apresentadora_pagamentos ADD COLUMN IF NOT EXISTS cancelado_por    UUID NULL REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE apresentadora_pagamentos ALTER COLUMN data_pagamento DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apresentadora_pagamentos_cancelado_motivo_check') THEN
    ALTER TABLE apresentadora_pagamentos ADD CONSTRAINT apresentadora_pagamentos_cancelado_motivo_check
      CHECK (cancelado_motivo IS NULL OR char_length(cancelado_motivo) <= 300);
  END IF;
END $$;

COMMENT ON COLUMN apresentadora_pagamentos.cancelado_em IS
  'Pagamento de apresentadora cancelado (não será pago). Sai do a pagar e do previsto; NULL = ativo.';
