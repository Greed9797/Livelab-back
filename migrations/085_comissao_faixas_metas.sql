-- Migration 085: faixas de comissão progressiva, metas mensais e campos de valor fixo
-- Objetivo:
--   1. Adicionar valor_fixo_minimo em marcas (mínimo garantido por marca tipo cliente)
--   2. Adicionar valor_fixo_mensal em apresentadoras (piso mensal do apresentador)
--   3. Criar tabela apresentadora_faixas_comissao (tiers progressivos de GMV)
--   4. Criar tabela metas_apresentadora (meta mensal por apresentadora)
--   5. Criar tabela metas_supervisor (meta mensal consolidada por franqueado)

-- 1. valor_fixo_minimo em marcas
ALTER TABLE marcas
  ADD COLUMN IF NOT EXISTS valor_fixo_minimo NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN marcas.valor_fixo_minimo IS
  'Para tipo=cliente: mínimo garantido pela marca mesmo que GMV × pct seja menor. Tipo afiliada: ignorado.';

-- 2. valor_fixo_mensal em apresentadoras
ALTER TABLE apresentadoras
  ADD COLUMN IF NOT EXISTS valor_fixo_mensal NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN apresentadoras.valor_fixo_mensal IS
  'Piso mensal garantido à apresentadora. Comissão = MAX(fixo_mensal, Σ variáveis do mês).';

-- 3. Faixas de comissão progressiva por apresentadora
CREATE TABLE IF NOT EXISTS apresentadora_faixas_comissao (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  gmv_min          NUMERIC(15,2) NOT NULL DEFAULT 0,
  gmv_max          NUMERIC(15,2),           -- NULL = sem teto
  pct_comissao     NUMERIC(5,2)  NOT NULL,  -- % do GMV da live
  vigente_desde    DATE          NOT NULL DEFAULT CURRENT_DATE,
  criado_em        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_faixa_range CHECK (gmv_max IS NULL OR gmv_max > gmv_min),
  CONSTRAINT chk_pct CHECK (pct_comissao >= 0 AND pct_comissao <= 100)
);

CREATE INDEX IF NOT EXISTS idx_faixas_apresentadora
  ON apresentadora_faixas_comissao(tenant_id, apresentadora_id, gmv_min);

ALTER TABLE apresentadora_faixas_comissao ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS faixas_tenant ON apresentadora_faixas_comissao;
CREATE POLICY faixas_tenant ON apresentadora_faixas_comissao
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- 4. Metas mensais por apresentadora
CREATE TABLE IF NOT EXISTS metas_apresentadora (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  mes_referencia   DATE NOT NULL,  -- sempre o dia 1 do mês
  gmv_meta         NUMERIC(15,2) NOT NULL DEFAULT 0,
  criado_por       UUID REFERENCES users(id),
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (apresentadora_id, mes_referencia)
);

CREATE INDEX IF NOT EXISTS idx_metas_ap_tenant_mes
  ON metas_apresentadora(tenant_id, mes_referencia);

ALTER TABLE metas_apresentadora ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS metas_ap_tenant ON metas_apresentadora;
CREATE POLICY metas_ap_tenant ON metas_apresentadora
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- 5. Meta mensal consolidada do supervisor (soma das metas das apresentadoras ou manual)
CREATE TABLE IF NOT EXISTS metas_supervisor (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mes_referencia           DATE NOT NULL,
  gmv_meta_total           NUMERIC(15,2) NOT NULL DEFAULT 0,
  calculado_automaticamente BOOLEAN NOT NULL DEFAULT true,
  supervisor_id            UUID REFERENCES users(id),
  criado_em                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, mes_referencia)
);

CREATE INDEX IF NOT EXISTS idx_metas_sup_tenant_mes
  ON metas_supervisor(tenant_id, mes_referencia);

ALTER TABLE metas_supervisor ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS metas_sup_tenant ON metas_supervisor;
CREATE POLICY metas_sup_tenant ON metas_supervisor
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
