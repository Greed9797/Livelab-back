-- Migration 012: TikTok tokens por tenant
ALTER TABLE tenants
  ADD COLUMN tiktok_access_token TEXT,
  ADD COLUMN tiktok_refresh_token TEXT,
  ADD COLUMN tiktok_token_expires_at TIMESTAMPTZ,
  ADD COLUMN tiktok_user_id TEXT;
