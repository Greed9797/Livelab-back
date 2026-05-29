-- Limpeza segura das cabines excedentes de Blumenau.
-- Nao rode sem revisar o diagnostico. Este arquivo termina com ROLLBACK por padrao.

BEGIN;

-- 1. Defina o tenant.
-- \set tenant_blumenau '<TENANT_BLUMENAU>'

-- 2. Liste cabines candidatas, priorizando cabines sem historico.
WITH historico AS (
  SELECT c.id,
         c.numero,
         c.nome,
         c.status,
         c.ativo,
         COUNT(DISTINCT l.id) AS total_lives,
         COUNT(DISTINCT ae.id) AS total_eventos
  FROM cabines c
  LEFT JOIN lives l
    ON l.cabine_id = c.id
   AND l.tenant_id = c.tenant_id
  LEFT JOIN agenda_eventos ae
    ON ae.cabine_id = c.id
   AND ae.tenant_id = c.tenant_id
  WHERE c.tenant_id = '<TENANT_BLUMENAU>'::uuid
  GROUP BY c.id, c.numero, c.nome, c.status, c.ativo
)
SELECT *
FROM historico
ORDER BY (total_lives + total_eventos) ASC, numero DESC;

-- 3. Exemplo seguro: inativar cabines excedentes escolhidas manualmente.
-- UPDATE cabines
-- SET ativo = false,
--     status = 'manutencao',
--     atualizado_em = NOW()
-- WHERE tenant_id = '<TENANT_BLUMENAU>'::uuid
--   AND id IN (
--     '<CABINE_ID_1>'::uuid,
--     '<CABINE_ID_2>'::uuid,
--     '<CABINE_ID_3>'::uuid
--   );

-- 4. Confirme o resultado antes de trocar ROLLBACK por COMMIT.
SELECT id, numero, nome, status, ativo
FROM cabines
WHERE tenant_id = '<TENANT_BLUMENAU>'::uuid
ORDER BY numero;

ROLLBACK;
-- COMMIT;
