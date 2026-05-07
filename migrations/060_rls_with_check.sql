-- Migration 060 — Adicionar WITH CHECK em todas RLS policies multi-tenant.
-- Quando cmd=ALL e WITH CHECK ausente, PG usa USING como WITH CHECK por default
-- (igual proteção). Explicit é melhor para auditoria + clareza.
--
-- Idempotente: DROP IF EXISTS + CREATE.

DO $$
DECLARE
  rec RECORD;
  policies_recriadas int := 0;
BEGIN
  -- Itera todas policies em tabelas multi-tenant que tem cmd=ALL
  -- e WITH CHECK NULL — recria com WITH CHECK explícito.
  FOR rec IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND cmd = 'ALL'
       AND with_check IS NULL
       AND tablename IN (
         'apresentadoras', 'boletos', 'cabines',
         'cliente_metas', 'cliente_metricas_mensais',
         'clientes', 'contratos', 'custos',
         'live_apresentadores', 'live_products', 'live_requests',
         'live_snapshots', 'lives', 'onboarding_responses',
         'pacotes', 'recomendacoes', 'tenant_contact_history',
         'users'
       )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      rec.policyname, rec.tablename
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      rec.policyname, rec.tablename
    );
    policies_recriadas := policies_recriadas + 1;
  END LOOP;
  RAISE NOTICE '[migration 060] policies recriadas com WITH CHECK: %', policies_recriadas;
END $$;

-- leads usa franqueadora_id (não tenant_id). Recriar policy ALL com WITH CHECK.
DO $$
BEGIN
  DROP POLICY IF EXISTS leads_tenant ON leads;
  CREATE POLICY leads_tenant ON leads
    USING (franqueadora_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (franqueadora_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'leads não existe — skip';
END $$;
