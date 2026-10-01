-- 170 — Receitas avulsas (não vinculadas a marcas): aporte, serviço, reembolso, outros.
--
-- Entram na lista unificada de lançamentos (natureza 'receita', origem 'avulsa'),
-- no fluxo de caixa e em GET /v1/financeiro/caixa. Grupo 'aporte' é entrada de
-- caixa SEPARADA: fica fora da receita operacional do DRE e da base do imposto.
-- Status NUNCA é gravado — derivado em src/lib/lancamento-status.js.
-- Idempotente.

CREATE TABLE IF NOT EXISTS receitas_avulsas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  descricao       TEXT NOT NULL,
  grupo           TEXT NOT NULL DEFAULT 'outros',
  valor_previsto  NUMERIC(15,2) NOT NULL,
  valor_pago      NUMERIC(15,2) NOT NULL DEFAULT 0,
  data_vencimento DATE NOT NULL,
  data_pagamento  DATE,
  competencia     DATE NOT NULL,
  observacao      TEXT,
  criado_por      UUID REFERENCES users(id) ON DELETE SET NULL,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT receitas_avulsas_grupo_check CHECK (grupo IN ('aporte', 'servico', 'reembolso', 'outros')),
  CONSTRAINT receitas_avulsas_valor_check CHECK (valor_previsto > 0 AND valor_pago >= 0),
  CONSTRAINT receitas_avulsas_competencia_check CHECK (EXTRACT(DAY FROM competencia) = 1),
  CONSTRAINT receitas_avulsas_pagamento_check CHECK (valor_pago = 0 OR data_pagamento IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS receitas_avulsas_competencia_idx
  ON receitas_avulsas (tenant_id, competencia);
CREATE INDEX IF NOT EXISTS receitas_avulsas_vencimento_idx
  ON receitas_avulsas (tenant_id, data_vencimento);
CREATE INDEX IF NOT EXISTS receitas_avulsas_pagamento_idx
  ON receitas_avulsas (tenant_id, data_pagamento)
  WHERE data_pagamento IS NOT NULL;

ALTER TABLE receitas_avulsas ENABLE ROW LEVEL SECURITY;
ALTER TABLE receitas_avulsas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receitas_avulsas_tenant ON receitas_avulsas;
CREATE POLICY receitas_avulsas_tenant ON receitas_avulsas
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE receitas_avulsas IS
  'Receitas avulsas (aporte|servico|reembolso|outros). Aporte = entrada de caixa fora da receita operacional e da base do imposto.';
