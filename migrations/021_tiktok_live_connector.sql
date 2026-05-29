-- migrations/021_tiktok_live_connector.sql

-- 1. TikTok @username do apresentador (ex: 'livestream_nike', sem o @)
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS tiktok_username TEXT;

-- 2. Métricas de engajamento nos snapshots
ALTER TABLE live_snapshots
  ADD COLUMN IF NOT EXISTS likes_count    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comments_count BIGINT NOT NULL DEFAULT 0;
