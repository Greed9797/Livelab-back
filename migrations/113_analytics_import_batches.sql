-- Import batches for TikTok Ads exports.
-- Preview rows are persisted so the user can review matches before applying.

CREATE TABLE IF NOT EXISTS analytics_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  filename TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'tiktok_ads'
    CHECK (source_type IN ('tiktok_ads')),
  status TEXT NOT NULL DEFAULT 'preview'
    CHECK (status IN ('preview', 'applied', 'cancelled')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  matched_rows INTEGER NOT NULL DEFAULT 0,
  ambiguous_rows INTEGER NOT NULL DEFAULT 0,
  unmatched_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  applied_rows INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  applied_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS analytics_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  batch_id UUID NOT NULL REFERENCES analytics_import_batches(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  raw JSONB NOT NULL,
  normalized JSONB NOT NULL,
  marca_nome TEXT,
  live_date DATE,
  start_time TEXT,
  duration_seconds INTEGER,
  matched_live_id UUID REFERENCES lives(id) ON DELETE SET NULL,
  matched_agenda_evento_id UUID REFERENCES agenda_eventos(id) ON DELETE SET NULL,
  match_status TEXT NOT NULL
    CHECK (match_status IN ('matched', 'ambiguous', 'unmatched', 'skipped_short', 'invalid')),
  match_confidence NUMERIC(8,4),
  match_reason TEXT,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  applied_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, row_index)
);

ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS ads_import_batch_id UUID REFERENCES analytics_import_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ads_import_row_id UUID REFERENCES analytics_import_rows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ads_metrics_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_analytics_import_batches_tenant_created
  ON analytics_import_batches(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_import_rows_batch_status
  ON analytics_import_rows(batch_id, match_status);

CREATE INDEX IF NOT EXISTS idx_analytics_import_rows_live
  ON analytics_import_rows(tenant_id, matched_live_id)
  WHERE matched_live_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lives_ads_import_batch
  ON lives(tenant_id, ads_import_batch_id)
  WHERE ads_import_batch_id IS NOT NULL;

ALTER TABLE analytics_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_import_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analytics_import_batches_tenant ON analytics_import_batches;
CREATE POLICY analytics_import_batches_tenant ON analytics_import_batches
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS analytics_import_rows_tenant ON analytics_import_rows;
CREATE POLICY analytics_import_rows_tenant ON analytics_import_rows
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

