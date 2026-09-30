-- Migration 165 — receitas a partir do comercial.
--
-- 1) Vencimento definido no COMERCIAL (regra única), versionado junto com a
--    condição comercial da marca. Defaults = planilha: dia 5 do mês seguinte.
--    Dia maior que o último dia do mês vira o último dia (regra aplicada no
--    cálculo, src/services/receitas-comercial.js).
-- 2) receita_titulos: títulos de receita (fixo | comissão) por marca e
--    competência, materializados/baixados pelo financeiro. O valor calculado
--    continua vindo do comercial; aqui só se persiste previsto/pago/vencimento.
--    Status NUNCA é gravado — é derivado em src/lib/lancamento-status.js.
--
-- Idempotente: pode rodar mais de uma vez.

ALTER TABLE marca_condicoes_comerciais
  ADD COLUMN IF NOT EXISTS fixo_vencimento_dia            SMALLINT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS fixo_vencimento_mes_offset     SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS comissao_vencimento_dia        SMALLINT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS comissao_vencimento_mes_offset SMALLINT NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marca_condicoes_fixo_vencimento_check') THEN
    ALTER TABLE marca_condicoes_comerciais
      ADD CONSTRAINT marca_condicoes_fixo_vencimento_check
      CHECK (fixo_vencimento_dia BETWEEN 1 AND 31 AND fixo_vencimento_mes_offset IN (0, 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marca_condicoes_comissao_vencimento_check') THEN
    ALTER TABLE marca_condicoes_comerciais
      ADD CONSTRAINT marca_condicoes_comissao_vencimento_check
      CHECK (comissao_vencimento_dia BETWEEN 1 AND 31 AND comissao_vencimento_mes_offset IN (0, 1));
  END IF;
END $$;

COMMENT ON COLUMN marca_condicoes_comerciais.fixo_vencimento_dia IS
  'Dia de vencimento do fixo (1-31). Dia maior que o último dia do mês = último dia.';
COMMENT ON COLUMN marca_condicoes_comerciais.fixo_vencimento_mes_offset IS
  '0 = vence no próprio mês da competência; 1 = no mês seguinte.';
COMMENT ON COLUMN marca_condicoes_comerciais.comissao_vencimento_dia IS
  'Dia de vencimento da comissão (1-31). Dia maior que o último dia do mês = último dia.';
COMMENT ON COLUMN marca_condicoes_comerciais.comissao_vencimento_mes_offset IS
  '0 = vence no próprio mês da competência; 1 = no mês seguinte.';

CREATE TABLE IF NOT EXISTS receita_titulos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  marca_id        UUID NOT NULL,
  cliente_id      UUID REFERENCES clientes(id) ON DELETE SET NULL,
  competencia     DATE NOT NULL,
  componente      TEXT NOT NULL,
  valor_previsto  NUMERIC(15,2) NOT NULL DEFAULT 0,
  valor_pago      NUMERIC(15,2) NOT NULL DEFAULT 0,
  data_vencimento DATE NOT NULL,
  data_pagamento  DATE,
  observacao      TEXT,
  criado_por      UUID REFERENCES users(id) ON DELETE SET NULL,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT receita_titulos_marca_fk
    FOREIGN KEY (tenant_id, marca_id) REFERENCES marcas (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT receita_titulos_competencia_check CHECK (EXTRACT(DAY FROM competencia) = 1),
  CONSTRAINT receita_titulos_componente_check CHECK (componente IN ('fixo', 'comissao')),
  CONSTRAINT receita_titulos_valores_check CHECK (valor_previsto >= 0 AND valor_pago >= 0),
  CONSTRAINT receita_titulos_pagamento_check CHECK (valor_pago = 0 OR data_pagamento IS NOT NULL),
  CONSTRAINT receita_titulos_uk UNIQUE (tenant_id, marca_id, competencia, componente)
);

CREATE INDEX IF NOT EXISTS receita_titulos_competencia_idx
  ON receita_titulos (tenant_id, competencia);
CREATE INDEX IF NOT EXISTS receita_titulos_vencimento_idx
  ON receita_titulos (tenant_id, data_vencimento);
CREATE INDEX IF NOT EXISTS receita_titulos_pagamento_idx
  ON receita_titulos (tenant_id, data_pagamento)
  WHERE data_pagamento IS NOT NULL;

ALTER TABLE receita_titulos ENABLE ROW LEVEL SECURITY;
ALTER TABLE receita_titulos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receita_titulos_tenant ON receita_titulos;
CREATE POLICY receita_titulos_tenant ON receita_titulos
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE receita_titulos IS
  'Títulos de receita (fixo/comissão) por marca e competência. Valor calculado pelo comercial; status derivado (nunca persistido).';
