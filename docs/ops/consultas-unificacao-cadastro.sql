-- SOMENTE LEITURA - NÃO ALTERA DADOS
-- =============================================================================
--
-- Diagnóstico da unificação Marca + Cliente ("cadastro", migrations 174–176).
-- Rodar ANTES do deploy (fotografia) e DEPOIS (comparar). Copiar o SELECT desejado
-- para uma sessão read-only. Este arquivo não contém INSERT/UPDATE/DELETE/
-- TRUNCATE/ALTER/DROP/COPY FROM.
--
-- Escopo opcional: descomentar as linhas `-- AND ...tenant_id = '<uuid>'::uuid`.
--
-- Modelo-alvo: marcas = cadastro (id público = marca_id); clientes = ficha 1:1
-- opcional da marca tipo='cliente'. Gera receita: tipo='cliente' AND NOT sistema
-- (src/lib/receita-marca-sql.js marcaGeraReceitaSql).
--
-- Esperado depois do deploy:
--   I1..I5, I7, I8: iguais a antes (F1–F4 não reescrevem cadastro nem títulos).
--   I6 (fora de união): 0 — a 176 preencheu; as de união continuam (não tocadas).
--   E1 (equivalência de títulos): IDÊNTICA antes/depois (nenhum UPDATE/DELETE em receita_titulos).
--   I9 lista títulos JÁ materializados de marca não-cliente: não somem (decisão manual).
-- Cada SELECT abaixo é independente.

-- ---------------------------------------------------------------------------
-- I1) Cliente não apagado SEM marca tipo='cliente' (não aparece em /v1/cadastros).
-- ---------------------------------------------------------------------------
SELECT c.tenant_id, c.id AS cliente_id, c.nome, c.status, c.criado_em
  FROM clientes c
 WHERE c.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM marcas m
                    WHERE m.tenant_id = c.tenant_id AND m.cliente_id = c.id AND m.tipo = 'cliente')
-- AND c.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY c.tenant_id, c.nome;

-- ---------------------------------------------------------------------------
-- I2) Marca tipo='cliente' sem cliente_id (CHECK da migration 080 deveria impedir).
-- ---------------------------------------------------------------------------
SELECT m.tenant_id, m.id AS marca_id, m.nome, m.status
  FROM marcas m
 WHERE m.tipo = 'cliente' AND m.cliente_id IS NULL
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- I3) Marca tipo='cliente' de cliente apagado ou mesclado.
--     Depois da F2 o cadastro aparece como 'arquivada' (status derivado); o DELETE
--     novo também arquiva a marca. Marcas antigas continuam com status gravado.
-- ---------------------------------------------------------------------------
SELECT m.tenant_id, m.id AS marca_id, m.nome, m.status AS status_marca,
       c.id AS cliente_id, c.deleted_at, c.mesclado_para_id
  FROM marcas m
  JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
 WHERE m.tipo = 'cliente' AND c.deleted_at IS NOT NULL
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- I4) Marca NÃO-cliente com cliente_id (afiliada/própria/parceira vinculada a um cliente).
--     Continua cadastro separado (decisão #1); no /v1/cadastros vem com cliente_id = null.
-- ---------------------------------------------------------------------------
SELECT m.tenant_id, m.id AS marca_id, m.nome, m.tipo, m.status, m.cliente_id, c.nome AS cliente_nome
  FROM marcas m
  LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
 WHERE m.tipo <> 'cliente' AND m.cliente_id IS NOT NULL
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- I5) Cliente com mais de uma marca (qualquer tipo).
-- ---------------------------------------------------------------------------
SELECT m.tenant_id, m.cliente_id, c.nome AS cliente_nome, count(*) AS marcas,
       string_agg(m.nome || ' (' || m.tipo || ')', ', ' ORDER BY m.nome) AS lista
  FROM marcas m
  LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
 WHERE m.cliente_id IS NOT NULL
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 GROUP BY m.tenant_id, m.cliente_id, c.nome
HAVING count(*) > 1
 ORDER BY m.tenant_id, c.nome;

-- ---------------------------------------------------------------------------
-- I6) Lives com cliente_id NULL em marca tipo='cliente', separando as de união.
--     Fora de união = alvo da 176 (depois: 0). Em união = nunca tocadas.
-- ---------------------------------------------------------------------------
SELECT l.tenant_id,
       count(*) FILTER (WHERE l.uniao_id IS NULL AND l.uniao_destino_id IS NULL AND l.uniao_desfeita_em IS NULL) AS fora_de_uniao,
       count(*) FILTER (WHERE l.uniao_id IS NOT NULL OR l.uniao_destino_id IS NOT NULL OR l.uniao_desfeita_em IS NOT NULL) AS em_uniao
  FROM lives l
  JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
 WHERE l.cliente_id IS NULL AND m.tipo = 'cliente' AND m.cliente_id IS NOT NULL
-- AND l.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 GROUP BY l.tenant_id
 ORDER BY l.tenant_id;

-- ---------------------------------------------------------------------------
-- I7) Lives com cliente_id diferente do cliente da marca tipo='cliente'.
--     Nem a 175 nem a 176 sobrescrevem cliente_id informado.
-- ---------------------------------------------------------------------------
SELECT l.tenant_id, l.id AS live_id, l.iniciado_em, l.cliente_id AS cliente_da_live,
       m.id AS marca_id, m.nome AS marca_nome, m.cliente_id AS cliente_da_marca
  FROM lives l
  JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
 WHERE m.tipo = 'cliente' AND m.cliente_id IS NOT NULL
   AND l.cliente_id IS NOT NULL AND l.cliente_id <> m.cliente_id
-- AND l.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY l.tenant_id, l.iniciado_em DESC;

-- ---------------------------------------------------------------------------
-- I8) receita_titulos com cliente_id diferente do da marca, ou nulo em marca tipo cliente.
-- ---------------------------------------------------------------------------
SELECT rt.tenant_id, rt.id AS titulo_id, rt.competencia, rt.componente,
       rt.cliente_id AS cliente_do_titulo, m.id AS marca_id, m.nome AS marca_nome,
       m.tipo, m.cliente_id AS cliente_da_marca, rt.valor_previsto, rt.valor_pago
  FROM receita_titulos rt
  JOIN marcas m ON m.id = rt.marca_id AND m.tenant_id = rt.tenant_id
 WHERE m.tipo = 'cliente'
   AND (rt.cliente_id IS NULL OR rt.cliente_id IS DISTINCT FROM m.cliente_id)
-- AND rt.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY rt.tenant_id, rt.competencia, m.nome;

-- ---------------------------------------------------------------------------
-- I9) Títulos materializados de marca NÃO-cliente ou sistema (criados antes da regra
--     marcaGeraReceitaSql). Não são alterados por nada desta entrega — decisão manual.
-- ---------------------------------------------------------------------------
SELECT rt.tenant_id, rt.id AS titulo_id, rt.competencia, rt.componente,
       m.id AS marca_id, m.nome AS marca_nome, m.tipo, COALESCE(m.sistema, false) AS sistema,
       rt.valor_previsto, rt.valor_pago, rt.perdido_em
  FROM receita_titulos rt
  JOIN marcas m ON m.id = rt.marca_id AND m.tenant_id = rt.tenant_id
 WHERE NOT (m.tipo = 'cliente' AND COALESCE(m.sistema, false) = false)
-- AND rt.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY rt.tenant_id, rt.competencia, m.nome;

-- ---------------------------------------------------------------------------
-- I10) Nome do cliente diferente do nome da marca tipo cliente (o PATCH sincroniza
--      só quando o nome muda; legados podem divergir).
-- ---------------------------------------------------------------------------
SELECT m.tenant_id, m.id AS marca_id, m.nome AS marca_nome, c.id AS cliente_id, c.nome AS cliente_nome
  FROM marcas m
  JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
 WHERE m.tipo = 'cliente' AND c.deleted_at IS NULL AND m.nome IS DISTINCT FROM c.nome
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- I11) Índice único de nome de marca por tenant existe? (migration 129 pode ter
--      pulado a criação se havia duplicata). NULL = não existe.
-- ---------------------------------------------------------------------------
SELECT to_regclass('public.uniq_marca_nome_por_tenant') AS uniq_marca_nome_por_tenant,
       to_regclass('public.uniq_marca_cliente_por_tenant') AS uniq_marca_cliente_por_tenant,
       to_regclass('public.uniq_marca_sistema_por_tenant') AS uniq_marca_sistema_por_tenant;

-- ---------------------------------------------------------------------------
-- I12) Nº de marcas sistema por tenant (esperado: 1).
-- ---------------------------------------------------------------------------
SELECT t.id AS tenant_id, t.nome, count(m.id) FILTER (WHERE m.sistema) AS marcas_sistema
  FROM tenants t
  LEFT JOIN marcas m ON m.tenant_id = t.id
-- WHERE t.id = '00000000-0000-0000-0000-000000000000'::uuid
 GROUP BY t.id, t.nome
 ORDER BY marcas_sistema, t.nome;

-- ---------------------------------------------------------------------------
-- I13) Clientes com acesso ao portal (user_id) ou cliente no gateway (gateway_customer_id).
--      Ficha que precisa continuar existindo (portal/cobrança dependem dela).
-- ---------------------------------------------------------------------------
SELECT c.tenant_id, c.id AS cliente_id, c.nome, c.status, c.deleted_at,
       c.user_id, c.gateway_customer_id,
       (SELECT m.id FROM marcas m
         WHERE m.tenant_id = c.tenant_id AND m.cliente_id = c.id AND m.tipo = 'cliente'
         ORDER BY (m.status = 'ativa') DESC, m.atualizado_em DESC NULLS LAST, m.criado_em ASC
         LIMIT 1) AS marca_id
  FROM clientes c
 WHERE c.user_id IS NOT NULL OR c.gateway_customer_id IS NOT NULL
-- AND c.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY c.tenant_id, c.nome;

-- ---------------------------------------------------------------------------
-- I14) Clientes FORA da carteira (GET /v1/clientes lista só ativo/inadimplente/cancelado
--      e não apagados) cuja marca tipo cliente está ativa. No /v1/cadastros eles
--      aparecem (a marca manda); na lista antiga de clientes, não.
-- ---------------------------------------------------------------------------
SELECT c.tenant_id, c.id AS cliente_id, c.nome, c.status AS status_cliente, c.deleted_at,
       m.id AS marca_id, m.nome AS marca_nome, m.status AS status_marca
  FROM clientes c
  JOIN marcas m ON m.cliente_id = c.id AND m.tenant_id = c.tenant_id AND m.tipo = 'cliente'
 WHERE m.status = 'ativa'
   AND (c.deleted_at IS NOT NULL OR c.status NOT IN ('ativo', 'inadimplente', 'cancelado'))
-- AND c.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY c.tenant_id, c.nome;

-- ---------------------------------------------------------------------------
-- I15) tiktok_username preenchido em marca tipo cliente (o canônico é o do cliente —
--      migration 103; o PATCH de marca zera o da marca).
-- ---------------------------------------------------------------------------
SELECT m.tenant_id, m.id AS marca_id, m.nome, m.tiktok_username AS tiktok_marca,
       c.tiktok_username AS tiktok_cliente
  FROM marcas m
  LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
 WHERE m.tipo = 'cliente' AND m.tiktok_username IS NOT NULL
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- E1) Equivalência de dinheiro materializado: rodar ANTES e DEPOIS — tem de ser idêntico.
-- ---------------------------------------------------------------------------
SELECT competencia, componente, count(*), sum(valor_previsto), sum(valor_pago)
  FROM receita_titulos
-- WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- ---------------------------------------------------------------------------
-- E2) O que a F4b tira de Comissões/Ranking/Resumo legado: comissão de franquia
--     (GMV × % da condição vigente) de lives encerradas de marca que NÃO gera receita,
--     por mês. Rodar ANTES do deploy: é exatamente o valor que deixa de aparecer.
--     (Vídeos: mesma ideia em vendas_atribuidas origem='video'.)
-- ---------------------------------------------------------------------------
SELECT l.tenant_id,
       date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date AS mes,
       m.id AS marca_id, m.nome, m.tipo, COALESCE(m.sistema, false) AS sistema,
       sum(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)) AS gmv,
       sum(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) * COALESCE(c.comissao_franquia_pct, 0) / 100.0) AS comissao_que_sai
  FROM lives l
  JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
  LEFT JOIN LATERAL (
    SELECT cc.comissao_franquia_pct
      FROM marca_condicoes_comerciais cc
     WHERE cc.tenant_id = l.tenant_id AND cc.marca_id = l.marca_id
       AND cc.inicio_vigencia <= (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
       AND cc.cancelled_at IS NULL
     ORDER BY cc.inicio_vigencia DESC LIMIT 1
  ) c ON true
 WHERE l.status = 'encerrada'
   AND l.uniao_destino_id IS NULL AND l.uniao_desfeita_em IS NULL
   AND l.arquivada_em IS NULL
   AND NOT (m.tipo = 'cliente' AND COALESCE(m.sistema, false) = false)
-- AND l.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
 GROUP BY 1, 2, 3, 4, 5, 6
HAVING sum(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) * COALESCE(c.comissao_franquia_pct, 0)) > 0
 ORDER BY 1, 2 DESC, comissao_que_sai DESC;

-- ---------------------------------------------------------------------------
-- E3) Lives preenchidas pela 176 (depois do deploy) — conferência do backup.
-- ---------------------------------------------------------------------------
SELECT b.tenant_id, count(*) AS lives_preenchidas, min(b.aplicado_em), max(b.aplicado_em)
  FROM migr176_lives_cliente_id_backup b
 GROUP BY b.tenant_id
 ORDER BY b.tenant_id;
