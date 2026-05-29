-- Hardening RLS — fechar 4 vetores de vazamento de dados entre tenants/clientes.
-- Idempotente: pode rodar múltiplas vezes sem efeito colateral.

-- ─── 1. leads (usa franqueadora_id como tenant) ───────────────────────────────
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_tenant ON leads;
CREATE POLICY leads_tenant ON leads
  USING (franqueadora_id = current_setting('app.tenant_id', true)::uuid);

-- ─── 2. cliente_metas (multi-cliente sem tenant_id) ──────────────────────────
ALTER TABLE cliente_metas ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

UPDATE cliente_metas cm
   SET tenant_id = c.tenant_id
  FROM clientes c
 WHERE cm.cliente_id = c.id
   AND cm.tenant_id IS NULL;

-- Só força NOT NULL se backfill cobriu tudo
DO $$
DECLARE orfaos INT;
BEGIN
  SELECT COUNT(*) INTO orfaos FROM cliente_metas WHERE tenant_id IS NULL;
  IF orfaos = 0 THEN
    ALTER TABLE cliente_metas ALTER COLUMN tenant_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'cliente_metas: % rows com tenant_id NULL — não força NOT NULL agora', orfaos;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cm_tenant ON cliente_metas(tenant_id);

ALTER TABLE cliente_metas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cm_tenant ON cliente_metas;
CREATE POLICY cm_tenant ON cliente_metas
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── 3. live_apresentadores (associativa sem tenant_id) ──────────────────────
ALTER TABLE live_apresentadores ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

UPDATE live_apresentadores la
   SET tenant_id = l.tenant_id
  FROM lives l
 WHERE la.live_id = l.id
   AND la.tenant_id IS NULL;

DO $$
DECLARE orfaos INT;
BEGIN
  SELECT COUNT(*) INTO orfaos FROM live_apresentadores WHERE tenant_id IS NULL;
  IF orfaos = 0 THEN
    ALTER TABLE live_apresentadores ALTER COLUMN tenant_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'live_apresentadores: % rows com tenant_id NULL', orfaos;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_la_tenant ON live_apresentadores(tenant_id);

ALTER TABLE live_apresentadores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS la_tenant ON live_apresentadores;
CREATE POLICY la_tenant ON live_apresentadores
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── 4. tenant_contact_history ───────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_contact_history') THEN
    EXECUTE 'ALTER TABLE tenant_contact_history ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tch_tenant ON tenant_contact_history';
    EXECUTE 'CREATE POLICY tch_tenant ON tenant_contact_history
      USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
  END IF;
END $$;

-- ─── 5. clientes.user_id: garantir UNIQUE 1:1 (sem permitir órfãos confusos) ──
-- Migration 048 já criou; reaplicar idempotente.
DROP INDEX IF EXISTS idx_clientes_user_id;
CREATE UNIQUE INDEX idx_clientes_user_id ON clientes(user_id) WHERE user_id IS NOT NULL;
