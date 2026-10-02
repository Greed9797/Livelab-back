-- =============================================================================
-- ROLLBACK MANUAL das migrations 175 (gatilho) e 176 (backfill de lives.cliente_id)
-- =============================================================================
--
-- NÃO é migration e NÃO roda no deploy. Executar à mão, numa transação, só se o
-- dono decidir desfazer o preenchimento de lives.cliente_id.
--
-- O que desfaz:
--   Passo 1 (opcional): remove o gatilho da 175, para novas lives importadas
--                       voltarem a nascer sem cliente_id.
--   Passo 2: devolve cliente_id = NULL SÓ nas lives que a 176 preencheu
--            (tabela migr176_lives_cliente_id_backup) e que ainda têm exatamente
--            o cliente_id que a 176 gravou. Live editada depois (cliente_id
--            trocado à mão) não é tocada. Live de união não é tocada (o
--            guard_live_uniao recusaria; a 176 também não as alterou).
--
-- Não mexe em dinheiro (receita/comissão resolvem por marca_id) nem em receita_titulos.
-- A tabela de backup é mantida (sem DROP) para auditoria.
--
-- Conferência antes/depois:
--   SELECT count(*) FROM migr176_lives_cliente_id_backup;
--   SELECT count(*) FROM lives l JOIN migr176_lives_cliente_id_backup b
--     ON b.live_id = l.id AND b.tenant_id = l.tenant_id
--    WHERE l.cliente_id = b.cliente_id_novo;   -- antes: = backup; depois: 0

BEGIN;

-- Passo 1 (opcional) — descomente para remover o gatilho da 175:
-- DROP TRIGGER IF EXISTS lives_cliente_da_marca ON lives;

-- Passo 2 — por tenant, com app.tenant_id (funciona com ou sem BYPASSRLS).
DO $$
DECLARE
  r RECORD;
  n BIGINT;
  total BIGINT := 0;
BEGIN
  FOR r IN SELECT DISTINCT tenant_id FROM migr176_lives_cliente_id_backup ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', r.tenant_id::text, true);
    UPDATE lives l
       SET cliente_id = NULL
      FROM migr176_lives_cliente_id_backup b
     WHERE b.tenant_id = r.tenant_id
       AND l.tenant_id = r.tenant_id
       AND l.id = b.live_id
       AND l.cliente_id = b.cliente_id_novo
       AND l.uniao_id IS NULL
       AND l.uniao_destino_id IS NULL
       AND l.uniao_desfeita_em IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    RAISE NOTICE 'rollback 176: tenant % → % live(s) com cliente_id = NULL de volta', r.tenant_id, n;
  END LOOP;
  RAISE NOTICE 'rollback 176: total % live(s)', total;
END $$;

-- Confira as contagens acima e então:
COMMIT;   -- ou ROLLBACK;
