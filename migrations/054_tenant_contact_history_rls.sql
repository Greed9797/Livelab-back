-- Migration 053 falhou em aplicar RLS em tenant_contact_history (DO block silencioso).
-- Aplicado manual em prod. Registrar formalmente aqui pra idempotência em outros ambientes.

ALTER TABLE IF EXISTS tenant_contact_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tch_tenant ON tenant_contact_history;
CREATE POLICY tch_tenant ON tenant_contact_history
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
