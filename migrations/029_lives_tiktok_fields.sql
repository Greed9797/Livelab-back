-- migrations/029_lives_tiktok_fields.sql
-- Fase 1 da integração TikTok: campos mínimos em lives e live_snapshots
-- Spec: docs/specs/2026-04-12-tiktok-integration.md §2.3

-- ─── 1. Metadados e cache de métricas finais em lives ──────────────────────
-- Só campos que NÃO podem ser derivados de live_snapshots ou contratos.
-- tiktok_username fica em contratos (migration 021), não em lives.

ALTER TABLE lives ADD COLUMN IF NOT EXISTS tiktok_room_id           TEXT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_peak_viewers       INTEGER;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_likes        BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_comments     BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_total_shares       BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_gifts_diamonds     BIGINT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS final_orders_count       INTEGER;

-- Status de saúde do connector (usado pelo circuit breaker)
ALTER TABLE lives ADD COLUMN IF NOT EXISTS tiktok_connector_status  TEXT NOT NULL DEFAULT 'ok';

-- CHECK constraint adicionado separadamente pra ser idempotente em re-runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lives_tiktok_connector_status_check'
  ) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_tiktok_connector_status_check
      CHECK (tiktok_connector_status IN ('ok', 'degraded', 'offline'));
  END IF;
END$$;

-- ─── 2. Extensões em live_snapshots ────────────────────────────────────────
ALTER TABLE live_snapshots ADD COLUMN IF NOT EXISTS gifts_diamonds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE live_snapshots ADD COLUMN IF NOT EXISTS shares_count   BIGINT NOT NULL DEFAULT 0;
