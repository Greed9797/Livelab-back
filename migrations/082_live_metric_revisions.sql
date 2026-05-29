-- Migration 082: live_metric_revisions — histórico de alterações de métricas de GMV
-- Registra todas as alterações em fat_gerado e manual_gmv, rastreando histórico completo

CREATE TABLE IF NOT EXISTS live_metric_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  live_id UUID NOT NULL REFERENCES lives(id) ON DELETE CASCADE,
  campo TEXT NOT NULL,
  valor_anterior TEXT,
  valor_novo TEXT,
  motivo TEXT,
  alterado_por UUID REFERENCES users(id),
  alterado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_metric_revisions_live
  ON live_metric_revisions(live_id, alterado_em DESC);

CREATE INDEX IF NOT EXISTS idx_live_metric_revisions_tenant
  ON live_metric_revisions(tenant_id, alterado_em DESC);

ALTER TABLE live_metric_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY live_metric_revisions_tenant ON live_metric_revisions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ============================================================================
-- Fim da migration 082
-- ============================================================================
