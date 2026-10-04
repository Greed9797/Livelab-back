-- 174: cadastro unificado (marca = entidade única) — SÓ DIAGNÓSTICO + documentação.
--
-- Não altera dado nenhum. Não cria/derruba coluna, índice nem constraint.
-- Reaplicável: COMMENT ON é idempotente e o bloco DO só emite NOTICE/WARNING.
-- Nunca derruba o deploy: qualquer erro do diagnóstico vira WARNING
-- (EXCEPTION WHEN OTHERS), então o start do Railway segue.
--
-- Modelo-alvo (docs/financeiro.md §1 e src/lib/cadastro-sql.js):
--   marcas   = o "cadastro" (id público = marca_id), com tipo
--              cliente | afiliada | propria | parceira e sistema (migration 104).
--   clientes = ficha comercial/faturamento 1:1 OPCIONAL da marca tipo='cliente'
--              (cnpj, contato, gateway_customer_id, user_id do portal, contratos).
--   Só marca tipo='cliente' AND NOT sistema gera receita (marcaGeraReceitaSql).
--
-- As consultas detalhadas (I1..I15) estão em docs/ops/consultas-unificacao-cadastro.sql.

COMMENT ON TABLE marcas IS
  'Cadastro unificado (id público = marca_id). tipo cliente|afiliada|propria|parceira; '
  'só tipo=cliente AND NOT sistema gera receita (src/lib/receita-marca-sql.js marcaGeraReceitaSql). '
  'Marca tipo=cliente aponta para a ficha em clientes via cliente_id (1:1, uniq_marca_cliente_por_tenant). '
  'Ver migration 174 e src/lib/cadastro-sql.js.';

COMMENT ON TABLE clientes IS
  'Ficha comercial/faturamento 1:1 opcional da marca tipo=cliente (cnpj, contato, gateway_customer_id, '
  'user_id do portal, contratos, briefing). O cadastro exibido é a marca (GET /v1/cadastros). '
  'Ver migration 174.';

DO $$
DECLARE
  n_i1 BIGINT; n_i2 BIGINT; n_i3 BIGINT; n_i4 BIGINT; n_i5 BIGINT;
  n_i6 BIGINT; n_i6_uniao BIGINT; n_i7 BIGINT;
BEGIN
  BEGIN
    -- I1: cliente não apagado sem marca tipo cliente
    SELECT count(*) INTO n_i1
      FROM clientes c
     WHERE c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM marcas m
                        WHERE m.tenant_id = c.tenant_id AND m.cliente_id = c.id AND m.tipo = 'cliente');
    -- I2: marca tipo cliente sem cliente_id
    SELECT count(*) INTO n_i2 FROM marcas m WHERE m.tipo = 'cliente' AND m.cliente_id IS NULL;
    -- I3: marca tipo cliente de cliente apagado/mesclado
    SELECT count(*) INTO n_i3
      FROM marcas m JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
     WHERE m.tipo = 'cliente' AND c.deleted_at IS NOT NULL;
    -- I4: marca não-cliente com cliente_id
    SELECT count(*) INTO n_i4 FROM marcas m WHERE m.tipo <> 'cliente' AND m.cliente_id IS NOT NULL;
    -- I5: cliente com mais de uma marca (qualquer tipo)
    SELECT count(*) INTO n_i5 FROM (
      SELECT m.tenant_id, m.cliente_id FROM marcas m
       WHERE m.cliente_id IS NOT NULL
       GROUP BY m.tenant_id, m.cliente_id HAVING count(*) > 1
    ) x;
    -- I6: lives sem cliente_id com marca tipo cliente (fora e dentro de união)
    SELECT count(*) FILTER (WHERE l.uniao_id IS NULL AND l.uniao_destino_id IS NULL AND l.uniao_desfeita_em IS NULL),
           count(*) FILTER (WHERE l.uniao_id IS NOT NULL OR l.uniao_destino_id IS NOT NULL OR l.uniao_desfeita_em IS NOT NULL)
      INTO n_i6, n_i6_uniao
      FROM lives l JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
     WHERE l.cliente_id IS NULL AND m.tipo = 'cliente' AND m.cliente_id IS NOT NULL;
    -- I7: lives com cliente_id diferente do da marca tipo cliente
    SELECT count(*) INTO n_i7
      FROM lives l JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
     WHERE m.tipo = 'cliente' AND m.cliente_id IS NOT NULL
       AND l.cliente_id IS NOT NULL AND l.cliente_id <> m.cliente_id;

    RAISE NOTICE '[174 cadastro] I1 clientes sem marca tipo cliente: %', n_i1;
    RAISE NOTICE '[174 cadastro] I2 marcas tipo cliente sem cliente_id: %', n_i2;
    RAISE NOTICE '[174 cadastro] I3 marcas tipo cliente de cliente apagado/mesclado: %', n_i3;
    RAISE NOTICE '[174 cadastro] I4 marcas não-cliente com cliente_id: %', n_i4;
    RAISE NOTICE '[174 cadastro] I5 clientes com >1 marca: %', n_i5;
    RAISE NOTICE '[174 cadastro] I6 lives sem cliente_id em marca tipo cliente: % (+ % em união, não serão tocadas)', n_i6, n_i6_uniao;
    RAISE NOTICE '[174 cadastro] I7 lives com cliente_id ≠ marca: %', n_i7;
    IF n_i1 > 0 OR n_i2 > 0 OR n_i3 > 0 THEN
      RAISE WARNING '[174 cadastro] invariantes I1/I2/I3 violadas — rode docs/ops/consultas-unificacao-cadastro.sql (nada foi alterado)';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[174 cadastro] diagnóstico não pôde rodar (%): %. Nada foi alterado.', SQLSTATE, SQLERRM;
  END;
END $$;
