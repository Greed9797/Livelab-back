-- Indexes for /v1/home/dashboard hot paths.
-- All are safe to re-run and scoped by tenant for RLS-compatible lookups.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_va_home_dashboard_tenant_data_origem
  ON vendas_atribuidas(tenant_id, data, origem)
  WHERE origem IN ('live', 'video')
    AND COALESCE(status_aprovacao, 'pendente_aprovacao') <> 'reprovada';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agenda_home_dashboard_today
  ON agenda_eventos(tenant_id, tipo, status, data_inicio)
  WHERE tipo = 'live'
    AND status IN ('planejado', 'confirmado', 'ao_vivo');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_live_snapshots_home_dashboard_latest
  ON live_snapshots(tenant_id, live_id, captured_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_home_dashboard_status_started
  ON lives(tenant_id, status, iniciado_em DESC)
  WHERE status IN ('em_andamento', 'encerrada');
