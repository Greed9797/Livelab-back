-- Migration 127 — Habilitar RLS nas 5 tabelas multi-tenant que ficaram de fora.
--
-- Todas têm coluna tenant_id mas nunca receberam ENABLE ROW LEVEL SECURITY,
-- ou seja: qualquer conexão via dbTenant() enxergava linhas de todos os tenants.
--   meta_unidade            (migration 100)
--   lead_contatos           (migration 086)
--   lead_tarefas            (migration 086)
--   lead_etapa_historico    (migration 086)
--   cliente_merge_auditoria (migration 088)
--
-- Molde da policy: migration 060 — UMA policy por tabela com cmd=ALL,
-- USING (SELECT/UPDATE/DELETE) + WITH CHECK (INSERT/UPDATE) explícitos.
--
-- Além da RLS: meta_unidade é a única das 5 SEM foreign key de tenant_id
-- (as outras 4 já declaram REFERENCES tenants(id) desde a criação).
--
-- ⚠️ ATENÇÃO — RISCO DE tenant_id ÓRFÃO EM meta_unidade
-- Como nunca houve FK, é possível que existam linhas com tenant_id apontando
-- para um tenant inexistente (import manual, tenant deletado, seed antigo).
-- Essas linhas fariam o ADD CONSTRAINT falhar. Esta migration NÃO deleta nada:
-- ela conta os órfãos antes e, se houver algum, emite RAISE WARNING e PULA a
-- criação da FK — a parte de RLS (crítica de segurança) é aplicada mesmo assim.
-- Se o log do deploy mostrar o warning, limpar/reatribuir as linhas à mão e
-- rodar esta migration de novo (é idempotente).
--
-- Idempotente: ENABLE RLS é no-op se já ativa, DROP POLICY IF EXISTS antes de
-- cada CREATE POLICY, e a FK só é criada se não existir em pg_constraint.

DO $$
DECLARE
  tbl  text;
  pol  text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'meta_unidade',
    'lead_contatos',
    'lead_tarefas',
    'lead_etapa_historico',
    'cliente_merge_auditoria'
  ] LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      RAISE NOTICE '[migration 127] tabela % não existe — skip', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);

    pol := tbl || '_tenant';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      pol, tbl
    );

    RAISE NOTICE '[migration 127] RLS + policy % aplicada em %', pol, tbl;
  END LOOP;
END $$;

-- FK faltante em meta_unidade (as outras 4 já têm REFERENCES tenants(id)).
DO $$
DECLARE
  orfas bigint;
BEGIN
  IF to_regclass('public.meta_unidade') IS NULL THEN
    RAISE NOTICE '[migration 127] meta_unidade não existe — skip FK';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'meta_unidade_tenant_id_fkey'
       AND conrelid = 'public.meta_unidade'::regclass
  ) THEN
    RAISE NOTICE '[migration 127] FK meta_unidade_tenant_id_fkey já existe — skip';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO orfas
    FROM meta_unidade m
   WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = m.tenant_id);

  IF orfas > 0 THEN
    RAISE WARNING '[migration 127] % linha(s) em meta_unidade com tenant_id órfão — FK NÃO criada. Corrigir os dados à mão e reaplicar esta migration.', orfas;
    RETURN;
  END IF;

  ALTER TABLE meta_unidade
    ADD CONSTRAINT meta_unidade_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

  RAISE NOTICE '[migration 127] FK meta_unidade_tenant_id_fkey criada';
END $$;
