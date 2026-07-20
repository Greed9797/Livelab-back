-- Migration 128 — Índices de performance para hot paths que hoje fazem seq scan.
--
-- Todos CONCURRENTLY: applyMigration() (apply_migrations.js:155) detecta a
-- palavra CONCURRENTLY no arquivo e roda os statements fora de transação,
-- um a um, via splitSqlStatements(). Por isso este arquivo NÃO pode conter
-- blocos DO $$ ... $$ nem ponto-e-vírgula dentro de comentários.
--
-- Idempotente via IF NOT EXISTS. Nota operacional: se um CREATE INDEX
-- CONCURRENTLY falhar no meio, o índice fica INVALID e precisa de DROP INDEX
-- manual antes de reaplicar (IF NOT EXISTS enxerga o índice inválido como
-- existente e pula).

-- 1) src/routes/home.js:357-362 — AVG(viewer_count) do mês por tenant.
--    Índices atuais são (tenant_id) sozinho, (captured_at) sozinho e
--    (tenant_id, live_id, captured_at DESC) da migration 112 — nenhum serve
--    como composto (tenant_id, captured_at), então a agregação varre a tabela.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_live_snapshots_tenant_captured
  ON live_snapshots(tenant_id, captured_at DESC);

-- 2) src/jobs/agenda_autostart.js:39-49 — roda a cada 30s, cross-tenant
--    (app.db, sem tenant_id no WHERE), hoje em seq scan de agenda_eventos.
--    Parcial: só os eventos ainda não iniciados interessam ao job.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agenda_autostart_pendentes
  ON agenda_eventos(data_inicio)
  WHERE tipo = 'live'
    AND status = 'planejado'
    AND live_id IS NULL;

-- 3) src/jobs/recalcular_comissoes.js:39-49 — SELECT DISTINCT tenant_id,
--    apresentadora_id das vendas pendentes do mês, a cada 10min, cross-tenant.
--    Colunas na ordem (data, tenant_id, apresentadora_id) permitem index-only
--    scan do DISTINCT dentro do range de datas.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_va_recalc_comissoes_pendentes
  ON vendas_atribuidas(data, tenant_id, apresentadora_id)
  WHERE gmv > 0
    AND COALESCE(comissao_apresentadora, 0) = 0
    AND COALESCE(status_aprovacao, 'pendente_aprovacao') = 'pendente_aprovacao';

-- 4) src/routes/lives.js:1519-1528 (e o LATERAL idêntico em 1369-1378) — busca
--    o evento de agenda mais próximo por (tenant_id, cabine_id, data_inicio).
--    idx_agenda_eventos_overlap tem as mesmas colunas mas é PARCIAL em
--    status IN ('planejado','confirmado','ao_vivo') e o LATERAL não filtra
--    status, então o planner não pode usá-lo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agenda_eventos_tenant_cabine_inicio
  ON agenda_eventos(tenant_id, cabine_id, data_inicio);

-- 5) src/routes/lives.js:1452-1578 — paginação de GET /v1/lives
--    (WHERE tenant_id [+ status opcional] ORDER BY iniciado_em DESC LIMIT/OFFSET).
--    idx_lives_home_dashboard_status_started (migration 112) é parcial em
--    status IN ('em_andamento','encerrada') e não cobre nem status='faturada'
--    nem a listagem sem filtro de status — por isso a versão total aqui.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lives_tenant_status_iniciado
  ON lives(tenant_id, status, iniciado_em DESC);
