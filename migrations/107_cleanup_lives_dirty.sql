-- Migration 107: Cleanup lives com duracao impossivel (>24h)
-- Cap de 4h aplicado em lives encerradas com duracao irreal
-- Baseado em scripts/cleanup_lives_dirty.sql (versao producao, sem DRY-RUN)
--
-- Contexto: Trigger ou cron de cleanup marcou encerrado_em = NOW() em massa
-- para lives travadas, criando durações impossíveis (até 420h / 17 dias).
-- Esta migration corrige o histórico, capando em (iniciado_em + 4h),
-- que é a duração média real de uma Live Shop.

BEGIN;

UPDATE lives
SET encerrado_em = iniciado_em + INTERVAL '4 hours'
WHERE status = 'encerrada'
  AND encerrado_em IS NOT NULL
  AND iniciado_em IS NOT NULL
  AND EXTRACT(EPOCH FROM (encerrado_em - iniciado_em)) / 3600.0 > 24;

COMMIT;
