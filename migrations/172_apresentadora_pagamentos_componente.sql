-- 172 — Pagamento de apresentadora dividido em dois componentes (fixo | variavel).
-- Cada pessoa/mês passa a ter até duas baixas independentes: FIXO (fixo do fechamento) e
-- VARIAVEL (comissão + adicionais), cada uma com vencimento próprio (config em tenants).
-- Baixas existentes viram componente 'fixo' (DEFAULT) — nenhum dado é perdido.
-- Também libera o tipo 'avulsa' (receitas_avulsas.id) na conciliação Asaas.
-- Idempotente.

ALTER TABLE apresentadora_pagamentos
  ADD COLUMN IF NOT EXISTS componente TEXT NOT NULL DEFAULT 'fixo';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apresentadora_pagamentos_componente_check') THEN
    ALTER TABLE apresentadora_pagamentos ADD CONSTRAINT apresentadora_pagamentos_componente_check
      CHECK (componente IN ('fixo', 'variavel'));
  END IF;
END $$;

ALTER TABLE apresentadora_pagamentos DROP CONSTRAINT IF EXISTS apresentadora_pagamentos_uk;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apresentadora_pagamentos_componente_uk') THEN
    ALTER TABLE apresentadora_pagamentos ADD CONSTRAINT apresentadora_pagamentos_componente_uk
      UNIQUE (tenant_id, apresentadora_id, competencia, componente);
  END IF;
END $$;

-- Vencimentos por componente. As colunas antigas (apresentadoras_vencimento_*) ficam, DEPRECIADAS.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS apresentadoras_fixo_vencimento_dia SMALLINT NOT NULL DEFAULT 10;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS apresentadoras_fixo_vencimento_mes_offset SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS apresentadoras_variavel_vencimento_dia SMALLINT NOT NULL DEFAULT 15;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS apresentadoras_variavel_vencimento_mes_offset SMALLINT NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_apres_fixo_venc_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_apres_fixo_venc_check
      CHECK (apresentadoras_fixo_vencimento_dia BETWEEN 1 AND 31
         AND apresentadoras_fixo_vencimento_mes_offset BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_apres_variavel_venc_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_apres_variavel_venc_check
      CHECK (apresentadoras_variavel_vencimento_dia BETWEEN 1 AND 31
         AND apresentadoras_variavel_vencimento_mes_offset BETWEEN 0 AND 1);
  END IF;
END $$;

COMMENT ON COLUMN tenants.apresentadoras_vencimento_dia IS 'DEPRECIADA (172): use apresentadoras_fixo_/variavel_vencimento_*';
COMMENT ON COLUMN tenants.apresentadoras_vencimento_mes_offset IS 'DEPRECIADA (172): use apresentadoras_fixo_/variavel_vencimento_*';

-- Conciliação: alvo 'avulsa' (receitas_avulsas.id).
ALTER TABLE gateway_transacoes DROP CONSTRAINT IF EXISTS chk_gateway_transacoes_tipo_alvo;
ALTER TABLE gateway_transacoes
  ADD CONSTRAINT chk_gateway_transacoes_tipo_alvo
  CHECK (conciliado_com_tipo IS NULL
         OR conciliado_com_tipo IN ('receita', 'avulsa', 'custo', 'apresentadora', 'imposto'));
