-- Otimiza queries analíticas com filtro por cliente + range de data
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_tenant_cliente_iniciado
  ON lives (tenant_id, cliente_id, iniciado_em);
