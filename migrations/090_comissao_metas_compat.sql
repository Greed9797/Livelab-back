-- Migration 090: compatibilidade de comissoes, fixos e metas.
-- Mantem a tabela de faixas oficial do backend: apresentadora_comissao_faixas.

ALTER TABLE marcas
  ADD COLUMN IF NOT EXISTS valor_fixo_minimo NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN marcas.valor_fixo_minimo IS
  'Minimo garantido por marca tipo cliente. Afiliadas ignoram este campo.';

ALTER TABLE apresentadoras
  ADD COLUMN IF NOT EXISTS valor_fixo_mensal NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN apresentadoras.valor_fixo_mensal IS
  'Piso mensal garantido a apresentadora. Comissao mensal pode usar MAX(fixo_mensal, variavel).';

CREATE TABLE IF NOT EXISTS metas_apresentadora (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  mes_referencia DATE NOT NULL,
  gmv_meta NUMERIC(15,2) NOT NULL DEFAULT 0,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, apresentadora_id, mes_referencia)
);

CREATE INDEX IF NOT EXISTS idx_metas_apresentadora_tenant_mes
  ON metas_apresentadora(tenant_id, mes_referencia);

ALTER TABLE metas_apresentadora ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS metas_apresentadora_tenant ON metas_apresentadora;
CREATE POLICY metas_apresentadora_tenant
  ON metas_apresentadora
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS metas_supervisor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mes_referencia DATE NOT NULL,
  gmv_meta_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  calculado_automaticamente BOOLEAN NOT NULL DEFAULT true,
  supervisor_id UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, mes_referencia)
);

CREATE INDEX IF NOT EXISTS idx_metas_supervisor_tenant_mes
  ON metas_supervisor(tenant_id, mes_referencia);

ALTER TABLE metas_supervisor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS metas_supervisor_tenant ON metas_supervisor;
CREATE POLICY metas_supervisor_tenant
  ON metas_supervisor
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
