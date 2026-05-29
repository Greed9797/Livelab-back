-- Instalações Appmax: cada merchant que instala o app gera um external_id único
-- e estável (mesma instalação → mesmo external_id em re-validações), conforme
-- exigência da URL de validação Appmax.
CREATE TABLE IF NOT EXISTS appmax_installations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  app_id        TEXT NOT NULL,
  client_id     TEXT,
  client_secret TEXT,
  external_key  TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Identidade da instalação — idempotência: app_id + client_id + external_key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appmax_install_identity
  ON appmax_installations (app_id, COALESCE(client_id, ''), COALESCE(external_key, ''));

CREATE UNIQUE INDEX IF NOT EXISTS idx_appmax_install_external_id
  ON appmax_installations (external_id);
