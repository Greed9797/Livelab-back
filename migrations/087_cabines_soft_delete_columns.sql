-- Garante colunas usadas pelo endpoint GET/DELETE /v1/cabines.
-- A migration 086 também adiciona essas colunas, mas ela ficou fora do
-- runner de boot em produção durante um deploy anterior.

ALTER TABLE cabines
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_cabines_operacionais
  ON cabines(tenant_id, ativo, deleted_at);
