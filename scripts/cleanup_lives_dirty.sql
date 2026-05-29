-- Cleanup de lives com encerrado_em incorreto (duração > 24h).
-- Causa raiz: cron de cleanup OR trigger setou encerrado_em em massa
-- (ex: ao detectar live travada, marcou encerrado_em = NOW() em vez do
-- horário real onde a live realmente acabou).
--
-- Lives identificadas em 2026-05-08:
--   8 lives com duração 44h–420h
--   max 420h ≈ 17 dias (clearly bug)
--
-- Decisão: cap encerrado_em em (iniciado_em + 4h) — duração média real
-- de Live Shop. Alternativa: deixar como está e o LEAST 24h no SQL filtra
-- na agregação. Esta opção fix os dados e mantém histórico mais útil.
--
-- DRY-RUN por default. Editar para COMMIT após validar.

BEGIN;

\echo '=== ANTES — lives com duracao > 24h ==='
SELECT id, iniciado_em, encerrado_em,
       ROUND(EXTRACT(EPOCH FROM (encerrado_em - iniciado_em)) / 3600.0, 1) AS horas
  FROM lives
 WHERE status = 'encerrada'
   AND encerrado_em IS NOT NULL
   AND EXTRACT(EPOCH FROM (encerrado_em - iniciado_em)) / 3600.0 > 24
 ORDER BY horas DESC;

UPDATE lives
   SET encerrado_em = iniciado_em + INTERVAL '4 hours'
 WHERE status = 'encerrada'
   AND encerrado_em IS NOT NULL
   AND EXTRACT(EPOCH FROM (encerrado_em - iniciado_em)) / 3600.0 > 24;

\echo '=== APOS — restantes (deve ser 0) ==='
SELECT COUNT(*) AS lives_dirty_apos
  FROM lives
 WHERE status = 'encerrada'
   AND encerrado_em IS NOT NULL
   AND EXTRACT(EPOCH FROM (encerrado_em - iniciado_em)) / 3600.0 > 24;

-- Decidir: ROLLBACK (dry-run) ou COMMIT (aplicar)
ROLLBACK;
-- COMMIT;
