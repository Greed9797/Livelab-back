-- F1: Sistema de notificações por e-mail (Resend).
-- Log de todas as notificações enviadas (sucesso ou erro) — base de auditoria
-- e de dedupe (evita spam). RLS por tenant.

CREATE TABLE IF NOT EXISTS notification_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL,
  ref_id        UUID,
  destinatario  TEXT NOT NULL,
  assunto       TEXT,
  enviado_em    TIMESTAMPTZ,
  erro          TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_log_tenant_tipo
  ON notification_log(tenant_id, tipo, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_notification_log_ref
  ON notification_log(ref_id) WHERE ref_id IS NOT NULL;

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_log_tenant ON notification_log;
CREATE POLICY notification_log_tenant ON notification_log
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
