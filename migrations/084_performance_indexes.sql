-- Migration 084: Índices para queries mais frequentes da reestruturação
-- Todos os índices usam IF NOT EXISTS para segurança em reaplications.

-- Lives por status (dashboards, listagem principal)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_status_tenant
  ON lives(tenant_id, status);

-- Lives por tipo (filtros afiliado/cliente/teste)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_tipo_tenant
  ON lives(tenant_id, tipo) WHERE tipo IS NOT NULL;

-- Lives por status_publicacao (filtro cliente_parceiro)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_status_publicacao
  ON lives(tenant_id, status_publicacao);

-- Lives por cliente (dashboard do cliente)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_cliente_tenant
  ON lives(tenant_id, cliente_id) WHERE cliente_id IS NOT NULL;

-- Lives por apresentador (comissionamento)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_apresentador_tenant
  ON lives(tenant_id, apresentador_id) WHERE apresentador_id IS NOT NULL;

-- Lives por data (analytics, ranking)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_iniciado_em_tenant
  ON lives(tenant_id, iniciado_em DESC);

-- Cabines por status (disponibilidade)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cabines_status_tenant
  ON cabines(tenant_id, status);

-- live_metric_revisions por live (histórico)
-- (pode já existir da 082 — IF NOT EXISTS garante idempotência)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_live_metric_revisions_live_em
  ON live_metric_revisions(live_id, alterado_em DESC);
