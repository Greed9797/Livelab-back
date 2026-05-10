-- Migration 070: papel gerente_regional (Tier 4) + tabela user_tenant_access
--
-- Adiciona o 16º papel ao sistema. Diferente dos demais (que vivem em UMA
-- unidade), o gerente_regional supervisiona N tenants específicos: subset
-- da rede, abaixo do franqueador_master que vê tudo.
--
-- A tabela user_tenant_access é N:N e fica SEM RLS — apenas franqueador_master
-- gerencia esta tabela via endpoints /v1/master/regional-managers/*. O backend
-- consulta diretamente via app.db (pool admin).
--
-- Decisão arquitetural: NUNCA embutir lista de tenants no JWT. O decorator
-- requireTenantAccess sempre busca do banco em cada request — assim, revogar
-- acesso tem efeito imediato (sem esperar expiração do token).

-- 1. Atualizar CHECK constraint de papel — adiciona gerente_regional.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_papel_check;
ALTER TABLE users ADD CONSTRAINT users_papel_check
  CHECK (papel IN (
    'franqueador_master', 'franqueado', 'cliente_parceiro',
    'gerente', 'gerente_comercial', 'financeiro', 'operacional',
    'apresentador', 'apresentadora',
    -- Tier 1 (migration 064)
    'financeiro_readonly', 'auditor',
    -- Tier 2 (migration 064)
    'suporte', 'produtor_live',
    -- Tier 3 (migration 064)
    'marketing', 'comercial_readonly',
    -- Tier 4 (migration 070)
    'gerente_regional'
  ));

-- 2. Tabela N:N user → tenants — apenas para papéis multi-tenant.
CREATE TABLE IF NOT EXISTS user_tenant_access (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  concedido_por   UUID REFERENCES users(id) ON DELETE SET NULL,
  concedido_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, tenant_id),
  -- Defesa contra auto-atribuição: master não atribui acesso pra si mesmo.
  CONSTRAINT user_tenant_access_no_self_grant CHECK (user_id <> concedido_por)
);

CREATE INDEX IF NOT EXISTS user_tenant_access_user_idx
  ON user_tenant_access(user_id);
CREATE INDEX IF NOT EXISTS user_tenant_access_tenant_idx
  ON user_tenant_access(tenant_id);

-- SEM RLS: tabela administrativa, acessada exclusivamente por endpoints
-- protegidos com requirePapel(['franqueador_master']). Habilitar RLS aqui
-- exigiria tenant_id no contexto, o que não faz sentido pra esta tabela
-- (que justamente quebra o modelo single-tenant).
