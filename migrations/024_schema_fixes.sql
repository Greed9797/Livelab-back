-- Migration 024: Schema fixes
-- Corrige índices faltantes em FKs críticas, FK órfã em cabines.live_atual_id,
-- CASCADE em live_snapshots/live_products, e RLS em leads.
-- Aplicar com: psql $DATABASE_URL -f migrations/024_schema_fixes.sql

-- ─── 1. ÍNDICES EM FOREIGN KEYS CRÍTICAS ─────────────────────────────────────

-- contratos.user_id (aprovador/revisor — sem índice desde migration 004)
CREATE INDEX IF NOT EXISTS idx_contratos_user_id
  ON contratos(user_id);

-- lives.cliente_id (filtros de lives por cliente — sem índice desde migration 007)
CREATE INDEX IF NOT EXISTS idx_lives_cliente_id
  ON lives(cliente_id);

-- live_products (sem nenhum índice desde migration 014)
CREATE INDEX IF NOT EXISTS idx_live_products_live_id
  ON live_products(live_id);

CREATE INDEX IF NOT EXISTS idx_live_products_tenant_id
  ON live_products(tenant_id);

-- boletos.live_id (adicionado na migration 019 sem índice)
CREATE INDEX IF NOT EXISTS idx_boletos_live_id
  ON boletos(live_id);

-- leads.franqueadora_id (sem índice desde migration 008)
CREATE INDEX IF NOT EXISTS idx_leads_franqueadora_id
  ON leads(franqueadora_id);

-- ─── 2. FK CONSTRAINT FALTANDO EM cabines.live_atual_id ──────────────────────
-- live_atual_id foi criado como UUID sem REFERENCES em migration 006.
-- Se um live for deletado, live_atual_id ficaria órfão.

ALTER TABLE cabines
  ADD CONSTRAINT fk_cabines_live_atual
  FOREIGN KEY (live_atual_id) REFERENCES lives(id) ON DELETE SET NULL;

-- ─── 3. CASCADE EM live_snapshots E live_products ────────────────────────────
-- Sem CASCADE, deletar uma live deixa snapshots e produtos órfãos.

ALTER TABLE live_snapshots
  DROP CONSTRAINT IF EXISTS live_snapshots_live_id_fkey;
ALTER TABLE live_snapshots
  ADD CONSTRAINT live_snapshots_live_id_fkey
  FOREIGN KEY (live_id) REFERENCES lives(id) ON DELETE CASCADE;

ALTER TABLE live_products
  DROP CONSTRAINT IF EXISTS live_products_live_id_fkey;
ALTER TABLE live_products
  ADD CONSTRAINT live_products_live_id_fkey
  FOREIGN KEY (live_id) REFERENCES lives(id) ON DELETE CASCADE;

-- ─── 4. COLUNA meta_diaria_gmv NA TABELA tenants ────────────────────────────
-- Adicionada na migration 022 mas não aplicada na instância Supabase.
-- Referenciada em src/routes/configuracoes.js — causa 500 sem esta coluna.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS meta_diaria_gmv NUMERIC(15,2) DEFAULT 10000;

-- ─── 5. RLS EM leads ─────────────────────────────────────────────────────────
-- Leads 'disponivel' são intencionalmente compartilhados entre franqueados
-- (business design), portanto a política permite leitura de leads disponíveis
-- a qualquer tenant autenticado e restringe leads já tomados ao tenant que os pegou.

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY leads_read ON leads
  FOR SELECT
  USING (
    status = 'disponivel'
    OR franqueadora_id = current_setting('app.tenant_id', true)::uuid
    OR pego_por = current_setting('app.tenant_id', true)::uuid
  );

CREATE POLICY leads_insert ON leads
  FOR INSERT
  WITH CHECK (franqueadora_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY leads_update ON leads
  FOR UPDATE
  USING (
    franqueadora_id = current_setting('app.tenant_id', true)::uuid
    OR pego_por = current_setting('app.tenant_id', true)::uuid
  );
