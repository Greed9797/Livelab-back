-- 166 — Baixa de pagamento das apresentadoras + vencimento configurável por tenant.
-- O valor previsto NÃO é gravado: vem de buscarFechamentoApresentadoras (fixo + comissão
-- aprovada + adicionais). Aqui só persistimos o que foi efetivamente pago.
-- Status (pendente/atrasado/parcial/pago) é sempre derivado, nunca persistido.

CREATE TABLE IF NOT EXISTS apresentadora_pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  competencia DATE NOT NULL,
  valor_pago NUMERIC(15,2) NOT NULL,
  data_pagamento DATE NOT NULL DEFAULT CURRENT_DATE,
  observacao TEXT,
  criado_por UUID REFERENCES users(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT apresentadora_pagamentos_competencia_check
    CHECK (competencia = date_trunc('month', competencia)::date),
  CONSTRAINT apresentadora_pagamentos_valor_check CHECK (valor_pago >= 0),
  CONSTRAINT apresentadora_pagamentos_uk UNIQUE (tenant_id, apresentadora_id, competencia)
);

CREATE INDEX IF NOT EXISTS apresentadora_pagamentos_competencia_idx
  ON apresentadora_pagamentos (tenant_id, competencia);

ALTER TABLE apresentadora_pagamentos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apresentadora_pagamentos_tenant ON apresentadora_pagamentos;
CREATE POLICY apresentadora_pagamentos_tenant ON apresentadora_pagamentos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS apresentadoras_vencimento_dia SMALLINT NOT NULL DEFAULT 10;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS apresentadoras_vencimento_mes_offset SMALLINT NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_apresentadoras_vencimento_dia_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_apresentadoras_vencimento_dia_check
      CHECK (apresentadoras_vencimento_dia BETWEEN 1 AND 31);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_apresentadoras_vencimento_offset_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_apresentadoras_vencimento_offset_check
      CHECK (apresentadoras_vencimento_mes_offset BETWEEN 0 AND 1);
  END IF;
END $$;

COMMENT ON TABLE apresentadora_pagamentos IS
  'Baixa mensal de pagamento de apresentadora (valor previsto vem do fechamento; status derivado).';
