-- Dedicated least-privilege executor for presenter portal requests. The
-- application login remains unchanged for legacy/public/integration paths;
-- only code that explicitly SET LOCAL ROLE uses this capability.
DO $$
BEGIN
  CREATE ROLE livelab_portal_runtime NOLOGIN NOINHERIT NOBYPASSRLS
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE livelab_portal_runtime NOLOGIN NOINHERIT NOBYPASSRLS
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
END $$;

-- The migration runner is the current production application role. Membership
-- lets it assume the NOLOGIN role; the runtime safety boundary is the explicit
-- SET LOCAL ROLE inside the portal executor, not an inheritance assumption.
GRANT livelab_portal_runtime TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO livelab_portal_runtime;

-- Supabase commonly grants new tables to anon/authenticated by default. These
-- two portal-only tables must never be reachable through direct client roles;
-- preserve all pre-existing integration grants by touching no other table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON apresentadora_live_submissoes,
      apresentadora_live_submissao_historico FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON apresentadora_live_submissoes,
      apresentadora_live_submissao_historico FROM authenticated;
  END IF;
END $$;

-- tenants historically had no policy because the owner bypassed RLS. The
-- portal only needs the current tenant row for FK/join visibility.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_portal_runtime_tenant ON tenants;
CREATE POLICY tenants_portal_runtime_tenant ON tenants
  FOR SELECT TO livelab_portal_runtime
  USING (id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT (id) ON tenants TO livelab_portal_runtime;

-- Read grants are column scoped where the portal never needs contact or login
-- information. Financial peer values are returned only through the allowlisted
-- ranking DTO in the portal route, never through a generic table endpoint.
GRANT SELECT (id, tenant_id, ativo, papel) ON users TO livelab_portal_runtime;
GRANT SELECT (id, tenant_id, user_id, nome, foto_url, fixo, comissao_pct, ativo, arquivada)
  ON apresentadoras TO livelab_portal_runtime;
GRANT SELECT (id, tenant_id, cliente_id, nome, tipo, status, criado_em,
  comissao_franquia_pct, comissao_franqueadora_pct, valor_fixo_minimo, logo_url, site)
  ON marcas TO livelab_portal_runtime;
GRANT SELECT (id, tenant_id, nome, numero, ativo, contrato_id), UPDATE (ativo)
  ON cabines TO livelab_portal_runtime;
GRANT SELECT (id, tenant_id, status, logo_url) ON clientes TO livelab_portal_runtime;
GRANT SELECT (id, tenant_id, cliente_id, status, comissao_pct) ON contratos TO livelab_portal_runtime;
GRANT SELECT (tenant_id, apresentadora_id, marca_id, ativo) ON apresentadora_marcas TO livelab_portal_runtime;
GRANT SELECT ON live_apresentadores TO livelab_portal_runtime;
GRANT SELECT, INSERT (tenant_id, live_id, apresentadora_id, papel, percentual_rateio)
  ON live_apresentadoras_v2 TO livelab_portal_runtime;
GRANT SELECT, INSERT, UPDATE ON apresentadora_live_submissoes TO livelab_portal_runtime;
GRANT SELECT, INSERT ON apresentadora_live_submissao_historico TO livelab_portal_runtime;
GRANT SELECT, INSERT (tenant_id, cabine_id, cliente_id, apresentador_id, gestor_id, status,
  iniciado_em, encerrado_em, fat_gerado, final_orders_count, resumo, tipo, status_publicacao,
  origem_dados, marca_id, comissao_calculada, comissao_apresentadora_pct, comissao_apresentadora_valor),
  UPDATE (agenda_evento_id, comissao_calculada, comissao_apresentadora_pct, comissao_apresentadora_valor)
  ON lives TO livelab_portal_runtime;
GRANT SELECT, INSERT (tenant_id, tipo, marca_id, cabine_id, apresentadora_id, data_inicio, data_fim, status,
  observacoes, criado_por, live_id), UPDATE (tipo, marca_id, cabine_id, apresentadora_id, data_inicio, data_fim,
  status, observacoes, atualizado_em, live_id)
  ON agenda_eventos TO livelab_portal_runtime;
GRANT SELECT ON agenda_evento_apresentadoras TO livelab_portal_runtime;
GRANT SELECT, INSERT, UPDATE ON vendas_atribuidas TO livelab_portal_runtime;
GRANT SELECT ON apresentadora_comissao_faixas, tenant_comissao_faixas_default,
  apresentadora_fixo_historico, video_registros TO livelab_portal_runtime;
