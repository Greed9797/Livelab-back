-- Migration 131 — fecha o gap de RLS de tabela que a auditoria (scripts/audit-rls.js)
-- apontou ao preparar a ativação de RLS em produção (2026-07-20).
--
-- user_tenant_access: RLS já habilitada mas SEM policy nenhuma = deny-all para
-- qualquer role sem bypass. É a tabela N:N do gerente_regional (0 linhas hoje).
-- Sem uma policy, no dia da virada de RLS o CRUD de acesso regional quebraria.
-- Policy no molde da 127 (predicado por app.tenant_id).
--
-- NÃO mexe em live_requests: apesar de a auditoria tê-la flagado, em produção ela
-- é uma VIEW sobre agenda_eventos + marcas (ambas com RLS), não uma tabela — herda
-- a RLS das bases, já está protegida. Um ALTER TABLE nela falharia (é view). O
-- falso positivo foi corrigido no próprio audit-rls.js (filtro table_type='BASE TABLE').
--
-- audit_log também fica de fora: seus tenant_id NULL (eventos de auth/sistema) são
-- legítimos — tratado como exceção no audit-rls.js, não forçando NOT NULL.
--
-- Idempotente: DROP POLICY IF EXISTS antes de criar.

DO $$
BEGIN
  IF to_regclass('public.user_tenant_access') IS NOT NULL THEN
    ALTER TABLE user_tenant_access ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS user_tenant_access_tenant ON user_tenant_access;
    CREATE POLICY user_tenant_access_tenant ON user_tenant_access
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    RAISE NOTICE '[migration 131] policy aplicada em user_tenant_access';
  END IF;
END $$;
