-- Sessao 1 franqueado: auditoria operacional, merge restrito e faixas de comissao.

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS mesclado_para_id UUID REFERENCES clientes(id),
  ADD COLUMN IF NOT EXISTS mesclado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mesclado_por UUID REFERENCES users(id);

CREATE TABLE IF NOT EXISTS cliente_merge_auditoria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cliente_vencedor_id UUID NOT NULL REFERENCES clientes(id),
  cliente_mesclado_id UUID NOT NULL REFERENCES clientes(id),
  criterio TEXT NOT NULL,
  migracoes JSONB NOT NULL DEFAULT '{}'::jsonb,
  executado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cliente_merge_auditoria_tenant
  ON cliente_merge_auditoria(tenant_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS apresentadora_comissao_faixas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  gmv_inicio NUMERIC(15,2) NOT NULL DEFAULT 0,
  gmv_fim NUMERIC(15,2),
  comissao_pct NUMERIC(7,4) NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (gmv_inicio >= 0),
  CHECK (gmv_fim IS NULL OR gmv_fim > gmv_inicio),
  CHECK (comissao_pct >= 0 AND comissao_pct <= 100)
);

CREATE INDEX IF NOT EXISTS idx_apresentadora_comissao_faixas_lookup
  ON apresentadora_comissao_faixas(tenant_id, apresentadora_id, ativo, gmv_inicio);

ALTER TABLE apresentadora_comissao_faixas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'apresentadora_comissao_faixas'
      AND policyname = 'apresentadora_comissao_faixas_tenant'
  ) THEN
    CREATE POLICY apresentadora_comissao_faixas_tenant
      ON apresentadora_comissao_faixas
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
