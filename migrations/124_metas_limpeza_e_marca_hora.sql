-- Migration 124: uniformização de metas.
-- 1. Remove metas diárias mortas (sem consumidor de cálculo — decisão 19/07/2026):
--    apresentadoras.meta_diaria_gmv e clientes.meta_diaria_gmv.
--    tenants.meta_diaria_gmv PERMANECE (fallback legado da meta mensal no home).
-- 2. Cria marca_metas_hora: meta de GMV/hora editável por mês por marca
--    (consumida pelo status operacional; substitui clientes.meta_gmv_hora como
--    fonte preferencial, que vira fallback).

ALTER TABLE apresentadoras DROP COLUMN IF EXISTS meta_diaria_gmv;
ALTER TABLE clientes       DROP COLUMN IF EXISTS meta_diaria_gmv;

CREATE TABLE IF NOT EXISTS marca_metas_hora (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  marca_id      UUID NOT NULL REFERENCES marcas(id)  ON DELETE CASCADE,
  ano_mes       CHAR(7) NOT NULL,  -- 'YYYY-MM', mesmo formato de meta_unidade
  meta_gmv_hora NUMERIC(15,2) NOT NULL DEFAULT 0,
  criado_por    UUID REFERENCES users(id),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, marca_id, ano_mes)
);

CREATE INDEX IF NOT EXISTS idx_marca_metas_hora_tenant_mes
  ON marca_metas_hora(tenant_id, ano_mes);

ALTER TABLE marca_metas_hora ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marca_metas_hora_tenant ON marca_metas_hora;
CREATE POLICY marca_metas_hora_tenant
  ON marca_metas_hora
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
