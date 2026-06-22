-- 117: lives.marca_id obrigatório (exige-ou-erra). Idempotente.
-- FK original: lives_marca_id_fkey (SET NULL), criada em migration 093, linha 6.

-- 1) Backfill: resolve marca-espelho do cliente para lives sem marca
--    (tipo='cliente' = marca-espelho do cliente; sem filtro de status).
UPDATE lives l
   SET marca_id = m.id
  FROM marcas m
 WHERE l.marca_id IS NULL
   AND m.tenant_id = l.tenant_id
   AND m.cliente_id = l.cliente_id
   AND m.tipo = 'cliente';

-- 2) Backfill afiliado/teste sem marca → marca-sistema do tenant.
UPDATE lives l
   SET marca_id = ms.id
  FROM marcas ms
 WHERE l.marca_id IS NULL
   AND l.tipo IN ('afiliado', 'teste')
   AND ms.tenant_id = l.tenant_id
   AND ms.sistema = TRUE;

-- 3) Pré-check: se ainda houver live sem marca, ABORTA e lista (decisão manual).
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM lives WHERE marca_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Migration 117 abortada: % live(s) sem marca resolvível. '
      'Rode: SELECT id, tenant_id, cliente_id, tipo, status FROM lives WHERE marca_id IS NULL; '
      'e corrija manualmente antes de reaplicar.', n;
  END IF;
END $$;

-- 4) Torna a coluna NOT NULL (idempotente: ALTER é no-op se já for NOT NULL).
ALTER TABLE lives ALTER COLUMN marca_id SET NOT NULL;

-- 5) Troca FK de ON DELETE SET NULL → ON DELETE RESTRICT (idempotente).
--    Lógica: só faz o DROP+ADD se a constraint atual ainda for SET NULL;
--    se já for RESTRICT (re-run), não toca nada.
DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  -- Busca o nome da FK de lives.marca_id que ainda usa DELETE_RULE = 'SET NULL'.
  SELECT tc.constraint_name INTO v_constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema   = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
   WHERE tc.table_schema    = 'public'
     AND tc.table_name      = 'lives'
     AND tc.constraint_type = 'FOREIGN KEY'
     AND kcu.column_name    = 'marca_id'
     AND rc.delete_rule     = 'SET NULL'
   LIMIT 1;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lives DROP CONSTRAINT %I', v_constraint_name);
    ALTER TABLE lives
      ADD CONSTRAINT lives_marca_id_fkey
      FOREIGN KEY (marca_id) REFERENCES marcas(id) ON DELETE RESTRICT;
  END IF;
END $$;
