-- Snapshot lives.comissao_apresentadora_* passa a ser derivado do motor (vendas_atribuidas).
-- Até aqui era calculado à parte com apresentadoras.comissao_pct chapado (0 em 13 de 18
-- cadastros de Blumenau) e divergia do Financeiro: 53 lives com snapshot positivo contra 497
-- com comissão no motor, nos últimos 60 dias. Backfill único; daqui em diante quem escreve
-- vendas_atribuidas (origem='live') sincroniza o snapshot (src/services/comissao-snapshot.js).
-- Idempotente: reexecutar produz o mesmo resultado. Live sem venda atribuída não é tocada.

UPDATE lives l
   SET comissao_apresentadora_valor = agg.valor,
       comissao_apresentadora_pct   = agg.pct
  FROM (
    SELECT tenant_id, origem_id AS live_id,
           SUM(comissao_apresentadora) AS valor,
           ROUND(SUM(comissao_apresentadora) / NULLIF(SUM(gmv), 0) * 100, 2) AS pct
      FROM vendas_atribuidas
     WHERE origem = 'live'
     GROUP BY tenant_id, origem_id
  ) agg
 WHERE l.id = agg.live_id
   AND l.tenant_id = agg.tenant_id
   AND (l.comissao_apresentadora_valor IS DISTINCT FROM agg.valor
        OR l.comissao_apresentadora_pct IS DISTINCT FROM agg.pct);
