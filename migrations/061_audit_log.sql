-- Audit log de ações críticas: deletes, mudanças de status,
-- alterações de senha, criação de usuários, mudança de contratos.
-- PII redacted no insert (helper Node.js scrub keys sensíveis).

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID,                    -- null para ações system-wide (login, etc)
  user_id     UUID,                    -- ator (NULL se anônimo/sistema)
  action      TEXT NOT NULL,           -- ex: 'cliente.delete', 'contrato.assinar'
  entity_type TEXT,                    -- ex: 'cliente', 'contrato', 'custo'
  entity_id   UUID,                    -- id do recurso afetado
  metadata    JSONB DEFAULT '{}'::jsonb, -- contexto extra (sempre PII-scrubbed)
  ip          TEXT,
  user_agent  TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_idx
  ON audit_log(tenant_id, criado_em DESC) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_user_idx
  ON audit_log(user_id, criado_em DESC) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_action_idx
  ON audit_log(action, criado_em DESC);

-- RLS: tenants vêem apenas seu próprio audit_log.
-- Ações system-wide (tenant_id NULL) só franqueador_master vê via app.db direto.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_tenant ON audit_log;
CREATE POLICY audit_log_tenant ON audit_log
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid OR tenant_id IS NULL);
