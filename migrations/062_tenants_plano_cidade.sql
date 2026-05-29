-- 062: Adiciona colunas plano + cidade + uf em tenants para o painel master
-- Idempotente; backfill 'Standard' para todos.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plano  TEXT NOT NULL DEFAULT 'Standard',
  ADD COLUMN IF NOT EXISTS cidade TEXT,
  ADD COLUMN IF NOT EXISTS uf     TEXT;

-- Heurística inicial: dono com email admin@liveshop.com vira plano Master
-- (one-shot; futuras mudanças devem ser explícitas via PATCH /v1/tenants/:id).
UPDATE tenants t
SET plano = 'Master'
FROM users u
WHERE u.tenant_id = t.id
  AND u.papel = 'franqueador_master'
  AND t.plano = 'Standard';

CREATE INDEX IF NOT EXISTS idx_tenants_plano ON tenants(plano);
