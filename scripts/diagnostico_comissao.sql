-- Diagnóstico READ-ONLY de saúde da comissão (cliente↔marca, lives órfãs, reconciliação).
-- Uso: rode no console SQL do Railway (psql). Não altera nada.
-- Para focar uma franquia, troque :tenant pelo UUID do tenant (ex: Blumenau) nas queries
-- marcadas, ou rode tudo (visão por tenant via GROUP BY).

-- 1) Clientes ATIVOS sem marca tipo='cliente' (deve ser 0 após a migration 115).
SELECT c.tenant_id, COUNT(*) AS clientes_sem_marca
FROM clientes c
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM marcas m
    WHERE m.tenant_id = c.tenant_id AND m.cliente_id = c.id AND m.tipo = 'cliente'
  )
GROUP BY c.tenant_id
ORDER BY clientes_sem_marca DESC;

-- 2) Marcas tipo='cliente' DUPLICADAS por cliente (deve ser 0 após a 115 + índice único).
SELECT tenant_id, cliente_id, COUNT(*) AS marcas_cliente
FROM marcas
WHERE tipo = 'cliente' AND cliente_id IS NOT NULL
GROUP BY tenant_id, cliente_id
HAVING COUNT(*) > 1
ORDER BY marcas_cliente DESC;

-- 3) Lives ENCERRADAS com GMV>0 SEM vendas_atribuidas (órfãs de comissão).
--    Deve cair para ~0 conforme o job de reconciliação roda (a cada 10 min).
SELECT l.tenant_id, COUNT(*) AS lives_orfas_comissao,
       ROUND(SUM(COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0))::numeric, 2) AS gmv_sem_comissao
FROM lives l
WHERE l.status = 'encerrada'
  AND COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM vendas_atribuidas va
    WHERE va.origem = 'live' AND va.origem_id = l.id
  )
GROUP BY l.tenant_id
ORDER BY lives_orfas_comissao DESC;

-- 4) Lives encerradas com marca_id NULL (deve cair para ~0: 115 faz backfill, engine auto-cura).
SELECT tenant_id, COUNT(*) AS lives_sem_marca
FROM lives
WHERE status = 'encerrada' AND marca_id IS NULL
GROUP BY tenant_id
ORDER BY lives_sem_marca DESC;

-- 5) Reconciliação Financeiro × Comissões no MÊS CORRENTE:
--    SUM(lives.comissao_calculada) deve bater com SUM(vendas_atribuidas.comissao_franquia).
WITH per_live AS (
  SELECT l.tenant_id,
         SUM(l.comissao_calculada) AS comissao_financeiro
  FROM lives l
  WHERE l.status = 'encerrada'
    AND date_trunc('month', l.iniciado_em) = date_trunc('month', NOW())
  GROUP BY l.tenant_id
),
per_va AS (
  SELECT va.tenant_id,
         SUM(va.comissao_franquia) AS comissao_aba_comissoes
  FROM vendas_atribuidas va
  WHERE va.origem = 'live'
    AND date_trunc('month', va.data::timestamp) = date_trunc('month', NOW())
    AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
  GROUP BY va.tenant_id
)
SELECT COALESCE(pl.tenant_id, pv.tenant_id) AS tenant_id,
       ROUND(COALESCE(pl.comissao_financeiro, 0)::numeric, 2)    AS financeiro,
       ROUND(COALESCE(pv.comissao_aba_comissoes, 0)::numeric, 2) AS aba_comissoes,
       ROUND((COALESCE(pl.comissao_financeiro, 0) - COALESCE(pv.comissao_aba_comissoes, 0))::numeric, 2) AS diferenca
FROM per_live pl
FULL OUTER JOIN per_va pv ON pv.tenant_id = pl.tenant_id
ORDER BY ABS(COALESCE(pl.comissao_financeiro, 0) - COALESCE(pv.comissao_aba_comissoes, 0)) DESC;
