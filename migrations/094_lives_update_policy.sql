-- Garante RLS policy explícita para UPDATE em lives.
-- Policy original (007) era USING-only — permite SELECT mas pode falhar em UPDATE com WITH CHECK ausente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'lives'
       AND policyname = 'lives_tenant_update'
  ) THEN
    CREATE POLICY lives_tenant_update ON lives
      FOR UPDATE
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
