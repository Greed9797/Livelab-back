-- Cleanup de lixo de QA em produção.
-- Roda via: psql "$DATABASE_URL_ADMIN" < scripts/cleanup_qa_data.sql
-- (precisa role com bypass de RLS — service_role do Supabase ou superuser)
--
-- DRY-RUN por padrão (termina em ROLLBACK). Editar pra COMMIT após validar SELECTs.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) custos: 'Custo E2E Teste' R$ 500 (deixa de QA acumulado)
-- ─────────────────────────────────────────────────────────────────────────────

\echo '=== ANTES — custos lixo ==='
SELECT 'custos_qa_lixo' AS tabela, COUNT(*) AS total
  FROM custos
 WHERE descricao = 'Custo E2E Teste'
   AND valor::numeric = 500;

SELECT id, tenant_id, descricao, valor, competencia, criado_em
  FROM custos
 WHERE descricao = 'Custo E2E Teste'
   AND valor::numeric = 500
 ORDER BY criado_em DESC
 LIMIT 5;

DELETE FROM custos
 WHERE descricao = 'Custo E2E Teste'
   AND valor::numeric = 500;

\echo '=== APÓS — custos lixo ==='
SELECT COUNT(*) AS restantes_apos_delete
  FROM custos
 WHERE descricao = 'Custo E2E Teste'
   AND valor::numeric = 500;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) apresentadoras: nome 'Teste*' email 'teste@gmail.com'
-- ─────────────────────────────────────────────────────────────────────────────

\echo '=== ANTES — apresentadoras lixo ==='
SELECT 'apresentadoras_qa_lixo' AS tabela, COUNT(*) AS total
  FROM apresentadoras
 WHERE nome ILIKE 'teste%'
   AND email = 'teste@gmail.com';

SELECT id, tenant_id, nome, email, criado_em
  FROM apresentadoras
 WHERE nome ILIKE 'teste%'
   AND email = 'teste@gmail.com'
 ORDER BY criado_em DESC;

DELETE FROM apresentadoras
 WHERE nome ILIKE 'teste%'
   AND email = 'teste@gmail.com';

\echo '=== APÓS — apresentadoras lixo ==='
SELECT COUNT(*) AS restantes_apos_delete
  FROM apresentadoras
 WHERE nome ILIKE 'teste%'
   AND email = 'teste@gmail.com';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) recomendacoes: nomes obviamente teste/lixo
-- Mantém recomendações com nomes legítimos (>=3 chars com espaço, etc).
-- ─────────────────────────────────────────────────────────────────────────────

\echo '=== ANTES — recomendacoes lixo ==='
SELECT 'recomendacoes_qa_lixo' AS tabela, COUNT(*) AS total
  FROM recomendacoes
 WHERE nome_indicado ~* '^(dasdsa|joao|rwer|tewtwe|testetete|fasfas|fas/as|321312|fafaa|rdferwc|teste|teste cliente|asd|qwerty)$'
    OR recomendante  ~* '^(dasdas|maria|rw3|tewtew|412|teste|fsafsa|Franqueado teste)$';

SELECT id, tenant_id, nome_indicado, recomendante, status, criado_em
  FROM recomendacoes
 WHERE nome_indicado ~* '^(dasdsa|joao|rwer|tewtwe|testetete|fasfas|fas/as|321312|fafaa|rdferwc|teste|teste cliente|asd|qwerty)$'
    OR recomendante  ~* '^(dasdas|maria|rw3|tewtew|412|teste|fsafsa|Franqueado teste)$'
 ORDER BY criado_em DESC;

DELETE FROM recomendacoes
 WHERE nome_indicado ~* '^(dasdsa|joao|rwer|tewtwe|testetete|fasfas|fas/as|321312|fafaa|rdferwc|teste|teste cliente|asd|qwerty)$'
    OR recomendante  ~* '^(dasdas|maria|rw3|tewtew|412|teste|fsafsa|Franqueado teste)$';

\echo '=== APÓS — recomendacoes lixo ==='
SELECT COUNT(*) AS restantes_apos_delete
  FROM recomendacoes
 WHERE nome_indicado ~* '^(dasdsa|joao|rwer|tewtwe|testetete|fasfas|fas/as|321312|fafaa|rdferwc|teste|teste cliente|asd|qwerty)$';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Decidir: ROLLBACK pra dry-run; COMMIT pra aplicar
-- Comentar a linha abaixo e descomentar COMMIT pra aplicar de verdade.
-- ─────────────────────────────────────────────────────────────────────────────

-- ROLLBACK;
COMMIT;
