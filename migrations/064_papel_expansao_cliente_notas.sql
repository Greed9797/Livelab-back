-- Migration 064: Expansão de papéis (Tier 1+2+3) + cliente_notas
--
-- Adiciona 6 novos papéis ao CHECK constraint da tabela users:
--   Tier 1: financeiro_readonly, auditor
--   Tier 2: suporte, produtor_live
--   Tier 3: marketing, comercial_readonly
--
-- gerente_regional (Tier 4) NÃO entra aqui — Fase C separada (multi-tenant).
--
-- Cria também tabela cliente_notas pra suporte+marketing escreverem notas
-- nos clientes (entidade que ainda não tinha histórico — leads já tem
-- historico_contatos JSONB desde migration 037).

-- 1. Atualizar CHECK constraint de papel
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_papel_check;
ALTER TABLE users ADD CONSTRAINT users_papel_check
  CHECK (papel IN (
    'franqueador_master', 'franqueado', 'cliente_parceiro',
    'gerente', 'gerente_comercial', 'financeiro', 'operacional',
    'apresentador', 'apresentadora',
    -- novos Tier 1
    'financeiro_readonly', 'auditor',
    -- novos Tier 2
    'suporte', 'produtor_live',
    -- novos Tier 3
    'marketing', 'comercial_readonly'
  ));

-- 2. Tabela cliente_notas
CREATE TABLE IF NOT EXISTS cliente_notas (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cliente_id  UUID        NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  autor_id    UUID        NOT NULL REFERENCES users(id),
  autor_nome  TEXT        NOT NULL,
  texto       TEXT        NOT NULL,
  tipo        TEXT        NOT NULL DEFAULT 'nota'
    CHECK (tipo IN ('nota', 'ligacao', 'reuniao', 'reclamacao', 'elogio')),
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  editado_em  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS cliente_notas_cliente_idx
  ON cliente_notas(cliente_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS cliente_notas_tenant_idx
  ON cliente_notas(tenant_id, criado_em DESC);

-- RLS por tenant (igual padrão do projeto)
ALTER TABLE cliente_notas ENABLE ROW LEVEL SECURITY;

CREATE POLICY cliente_notas_tenant_select ON cliente_notas
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY cliente_notas_tenant_insert ON cliente_notas
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY cliente_notas_tenant_update ON cliente_notas
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY cliente_notas_tenant_delete ON cliente_notas
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
