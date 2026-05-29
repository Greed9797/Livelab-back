-- Adds TikTok Shop Ads funnel metrics (manual entry) to lives table.
-- Values come from TikTok Ads Manager exports entered per live via PATCH /v1/lives/:id.

ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS ads_gmv              NUMERIC(15,2),   -- Ads GMV (total, pago + orgânico)
  ADD COLUMN IF NOT EXISTS ads_cost             NUMERIC(15,2),   -- Verba investida
  ADD COLUMN IF NOT EXISTS live_impressions     BIGINT,          -- Impressões do live no feed
  ADD COLUMN IF NOT EXISTS product_impressions  BIGINT,          -- Impressões de produto
  ADD COLUMN IF NOT EXISTS product_clicks       BIGINT,          -- Cliques em produto
  ADD COLUMN IF NOT EXISTS avg_viewing_duration NUMERIC(10,2),   -- Retenção média em segundos
  ADD COLUMN IF NOT EXISTS new_followers        INTEGER;         -- Seguidores ganhos na live
