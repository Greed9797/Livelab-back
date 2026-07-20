-- Migration 124: Briefing do cliente
--
-- Documento único de texto rico (Markdown) por cliente — relação 1:1.
-- Preenchido e lido pelo time interno na tela Comercial. O cliente final
-- (cliente_parceiro) NÃO vê no portal dele.
--
-- Tabela separada de `clientes` DE PROPÓSITO: a listagem de clientes é rota
-- quente de performance — manter o blob de conteúdo fora do SELECT da lista.
--
-- Molde: cliente_notas (migration 064), adaptado de N notas -> 1 briefing.
-- UNIQUE(cliente_id) garante o 1:1 e habilita o upsert (ON CONFLICT) da rota.

CREATE TABLE IF NOT EXISTS cliente_briefing (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cliente_id          UUID        NOT NULL UNIQUE REFERENCES clientes(id) ON DELETE CASCADE,
  conteudo            TEXT        NOT NULL DEFAULT '',
  atualizado_por_id   UUID        REFERENCES users(id),
  atualizado_por_nome TEXT,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cliente_briefing_tenant_idx
  ON cliente_briefing(tenant_id);

-- RLS por tenant (igual padrão do projeto / migration 064)
ALTER TABLE cliente_briefing ENABLE ROW LEVEL SECURITY;

CREATE POLICY cliente_briefing_tenant_select ON cliente_briefing
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY cliente_briefing_tenant_insert ON cliente_briefing
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY cliente_briefing_tenant_update ON cliente_briefing
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY cliente_briefing_tenant_delete ON cliente_briefing
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
