-- 052: Base do painel operacional (fase 2/8)
-- Aditivo e idempotente: colunas novas nullable (ou com default seguro), nada removido.
-- Regra central: "não informado" = NULL real. Zero só quando medido como zero.

-- ── lives ────────────────────────────────────────────────────────────────
-- clicks: cliques no link/carrinho durante a live. NULL = não informado (não derivar de 0).
ALTER TABLE lives ADD COLUMN IF NOT EXISTS clicks BIGINT;

-- Diagnóstico operacional por live (preenchido pelo motor de status / operação)
ALTER TABLE lives ADD COLUMN IF NOT EXISTS status_operacional TEXT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS problema TEXT;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS proxima_acao TEXT;

-- Comissão da apresentadora, separada da comissão LiveLab (lives.comissao_calculada).
-- pct congelado no momento do cálculo (auditoria), valor em R$.
ALTER TABLE lives ADD COLUMN IF NOT EXISTS comissao_apresentadora_pct NUMERIC(5,2);
ALTER TABLE lives ADD COLUMN IF NOT EXISTS comissao_apresentadora_valor NUMERIC(15,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lives_status_operacional_check'
  ) THEN
    ALTER TABLE lives ADD CONSTRAINT lives_status_operacional_check
      CHECK (status_operacional IN ('ok', 'atencao', 'critico', 'dados_incompletos'));
  END IF;
END $$;

-- ── clientes (marca) ─────────────────────────────────────────────────────
-- Meta de eficiência por hora. Default 500 (R$/h). Diagnóstico principal usa esta,
-- não a meta mensal (cliente_metas.meta_gmv segue como planejamento).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS meta_gmv_hora NUMERIC(12,2) DEFAULT 500;

-- Margem do cliente. NULL = não configurada → motor de status nunca retorna 'ok'.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS margem_pct NUMERIC(5,2);

-- ── live_snapshots ───────────────────────────────────────────────────────
ALTER TABLE live_snapshots ADD COLUMN IF NOT EXISTS clicks BIGINT;

-- ── RLS faltante (achado da auditoria fase 1) ────────────────────────────
-- cliente_metas não tem tenant_id: policy via join com clientes.
ALTER TABLE cliente_metas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cliente_metas_tenant ON cliente_metas;
CREATE POLICY cliente_metas_tenant ON cliente_metas
  USING (cliente_id IN (
    SELECT id FROM clientes WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
  ))
  WITH CHECK (cliente_id IN (
    SELECT id FROM clientes WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
  ));

-- live_apresentadores não tem tenant_id: policy via join com lives.
ALTER TABLE live_apresentadores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS live_apresentadores_tenant ON live_apresentadores;
CREATE POLICY live_apresentadores_tenant ON live_apresentadores
  USING (live_id IN (
    SELECT id FROM lives WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
  ))
  WITH CHECK (live_id IN (
    SELECT id FROM lives WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
  ));
