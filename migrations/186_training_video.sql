-- Direct-video training and versioned learner playback state.
ALTER TABLE training_trails
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

ALTER TABLE training_lessons
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS global_position INTEGER,
  ADD COLUMN IF NOT EXISTS video_provider TEXT,
  ADD COLUMN IF NOT EXISTS video_id TEXT,
  ADD COLUMN IF NOT EXISTS video_library_id TEXT,
  ADD COLUMN IF NOT EXISTS video_url TEXT,
  ADD COLUMN IF NOT EXISTS video_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE training_lessons DROP CONSTRAINT IF EXISTS training_lessons_source_kind_check;
ALTER TABLE training_lessons ADD CONSTRAINT training_lessons_source_kind_check
  CHECK (source_kind IN ('none', 'network_article', 'unit_material', 'direct_video'));
ALTER TABLE training_lessons ADD CONSTRAINT training_lessons_video_provider_check
  CHECK (video_provider IS NULL OR video_provider IN ('youtube', 'panda'));
ALTER TABLE training_lessons ADD CONSTRAINT training_lessons_video_version_check
  CHECK (video_version > 0);
ALTER TABLE training_lessons ADD CONSTRAINT training_lessons_direct_video_check
  CHECK (source_kind <> 'direct_video' OR
    (video_provider IS NOT NULL AND video_id IS NOT NULL AND video_url IS NOT NULL));

UPDATE training_lessons l SET global_position = seq.position
FROM (
  SELECT l.id, row_number() OVER (PARTITION BY m.trail_id ORDER BY m.sort_order, l.sort_order, l.id)::integer AS position
  FROM training_lessons l JOIN training_modules m ON m.id = l.module_id
) seq WHERE seq.id = l.id AND l.global_position IS NULL;

ALTER TABLE training_lessons ALTER COLUMN global_position SET DEFAULT 0;
ALTER TABLE training_lessons ALTER COLUMN global_position SET NOT NULL;
CREATE INDEX IF NOT EXISTS training_lessons_global_position_idx ON training_lessons(global_position, id);

CREATE TABLE IF NOT EXISTS training_video_progress (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
  video_version INTEGER NOT NULL,
  started_at TIMESTAMPTZ,
  last_opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_seconds DOUBLE PRECISION,
  last_position_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  position_revision INTEGER NOT NULL DEFAULT 0,
  watched_intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  watched_percent NUMERIC(12,8),
  completion_source TEXT,
  PRIMARY KEY (tenant_id, user_id, lesson_id, video_version),
  CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 86400),
  CHECK (last_position_seconds BETWEEN 0 AND 86400),
  CHECK (watched_percent IS NULL OR watched_percent BETWEEN 0 AND 100),
  CHECK (completion_source IS NULL OR completion_source = 'watched')
);
CREATE INDEX IF NOT EXISTS training_video_progress_user_last_idx
  ON training_video_progress (tenant_id, user_id, last_opened_at DESC);
ALTER TABLE training_video_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_video_progress FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_video_progress_tenant ON training_video_progress;
CREATE POLICY training_video_progress_tenant ON training_video_progress
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
