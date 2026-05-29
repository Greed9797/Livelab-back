-- Índices para acelerar agregações analíticas por tenant/status/janela temporal

CREATE INDEX IF NOT EXISTS idx_lives_tenant_status_iniciado_em_desc
  ON lives(tenant_id, status, iniciado_em DESC);
