CREATE TABLE IF NOT EXISTS live_apresentadores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id UUID NOT NULL REFERENCES lives(id) ON DELETE CASCADE,
  apresentador_id UUID NOT NULL REFERENCES users(id),
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(live_id, apresentador_id)
);

CREATE INDEX IF NOT EXISTS idx_live_apresentadores_live_id ON live_apresentadores(live_id);
CREATE INDEX IF NOT EXISTS idx_live_apresentadores_apresentador_id ON live_apresentadores(apresentador_id);
