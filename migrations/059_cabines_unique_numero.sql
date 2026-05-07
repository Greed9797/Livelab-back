-- Investigação: bug "Cabine 01 duplicada" relatado em QA não tem causa em DB.
-- Tabela `cabines` já possui UNIQUE (tenant_id, numero) desde 006_create_cabines.sql.
-- Confirmado via SELECT — zero duplicatas em prod.
--
-- Bug fica em backlog para investigação no frontend (render duplicado em
-- cabines_screen.dart ou stale provider state).
--
-- Migration mantida no histórico como placeholder idempotente.

DO $$
BEGIN
  RAISE NOTICE '[migration 059] no-op — UNIQUE (tenant_id, numero) já existe desde 006';
END $$;
