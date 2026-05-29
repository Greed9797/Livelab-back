-- migrations/020_asaas_integration_fixes.sql
-- Corrects quality issues introduced in 019_asaas_integration.sql
-- (019 was already applied — this migration applies the fixes as a new migration)

-- ============================================================
-- Fix 1 (Critical): Replace RULES with TRIGGERS on webhook_eventos
-- RULES with DO INSTEAD NOTHING silently swallow mutations.
-- BEFORE triggers that RAISE EXCEPTION follow the pattern in 016.
-- ============================================================

DROP RULE IF EXISTS no_delete_webhook_eventos ON webhook_eventos;
DROP RULE IF EXISTS no_update_webhook_eventos ON webhook_eventos;

CREATE OR REPLACE FUNCTION prevent_webhook_eventos_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'webhook_eventos is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_no_update_webhook_eventos ON webhook_eventos;
CREATE TRIGGER trg_no_update_webhook_eventos
  BEFORE UPDATE ON webhook_eventos
  FOR EACH ROW EXECUTE FUNCTION prevent_webhook_eventos_mutation();

DROP TRIGGER IF EXISTS trg_no_delete_webhook_eventos ON webhook_eventos;
CREATE TRIGGER trg_no_delete_webhook_eventos
  BEFORE DELETE ON webhook_eventos
  FOR EACH ROW EXECUTE FUNCTION prevent_webhook_eventos_mutation();

-- ============================================================
-- Fix 2 (Important): Add WITH CHECK to RLS policy
-- The original policy had only USING, leaving INSERTs/UPDATEs
-- unguarded by tenant isolation.
-- ============================================================

DROP POLICY IF EXISTS webhook_eventos_tenant_isolation ON webhook_eventos;

CREATE POLICY webhook_eventos_tenant_isolation
  ON webhook_eventos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ============================================================
-- Fix 3 (Important): Add missing indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_webhook_eventos_processado
  ON webhook_eventos(processado, criado_em ASC)
  WHERE processado = false;

CREATE INDEX IF NOT EXISTS idx_webhook_eventos_tenant
  ON webhook_eventos(tenant_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_eventos_boleto
  ON webhook_eventos(boleto_id, criado_em DESC);

-- ============================================================
-- Fix 4 (Important): Make event_type NOT NULL
-- Asaas always sends an event type; NULL means we can't process it.
-- NOTE: tenant_id is intentionally left nullable (webhook may arrive
--       before tenant resolution). Do NOT add NOT NULL there.
-- ============================================================

UPDATE webhook_eventos SET event_type = 'UNKNOWN' WHERE event_type IS NULL;

ALTER TABLE webhook_eventos ALTER COLUMN event_type SET NOT NULL;
