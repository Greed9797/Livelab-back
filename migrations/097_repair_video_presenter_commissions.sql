-- Repara registros de vídeos no consolidado de vendas atribuídas.
-- O ranking de apresentadoras lê vendas_atribuidas; vídeos antigos ou criados
-- antes de uma mudança de comissão podiam ficar sem linha consolidada ou com
-- comissao_apresentadora zerada.

DELETE FROM vendas_atribuidas va
USING video_registros vr
WHERE va.tenant_id = vr.tenant_id
  AND va.origem = 'video'
  AND va.origem_id = vr.id
  AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') = 'pendente_aprovacao'
  AND (
    COALESCE(vr.gmv_atribuido, 0) <= 0
    OR va.apresentadora_id IS DISTINCT FROM vr.apresentadora_id
  );

WITH video_calc AS (
  SELECT
    vr.tenant_id,
    'video'::text AS origem,
    vr.id AS origem_id,
    vr.marca_id,
    vr.apresentadora_id,
    vr.data,
    COALESCE(vr.gmv_atribuido, 0) AS gmv,
    COALESCE(vr.pedidos_atribuidos, 0) AS pedidos,
    COALESCE(vr.gmv_atribuido, 0)
      * (
        COALESCE(faixa.comissao_pct, NULLIF(am.comissao_video_pct, 0), NULLIF(a.comissao_pct, 0), 0)
        / 100.0
      ) AS comissao_apresentadora,
    COALESCE(vr.gmv_atribuido, 0) * (COALESCE(m.comissao_franquia_pct, 0) / 100.0) AS comissao_franquia,
    COALESCE(vr.gmv_atribuido, 0) * (COALESCE(m.comissao_franqueadora_pct, 0) / 100.0) AS comissao_franqueadora
  FROM video_registros vr
  JOIN marcas m
    ON m.id = vr.marca_id
   AND m.tenant_id = vr.tenant_id
  LEFT JOIN apresentadoras a
    ON a.id = vr.apresentadora_id
   AND a.tenant_id = vr.tenant_id
  LEFT JOIN apresentadora_marcas am
    ON am.tenant_id = vr.tenant_id
   AND am.marca_id = vr.marca_id
   AND am.apresentadora_id = vr.apresentadora_id
   AND am.ativo = true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(va2.gmv), 0) + COALESCE(vr.gmv_atribuido, 0) AS gmv_mes
    FROM vendas_atribuidas va2
    WHERE va2.tenant_id = vr.tenant_id
      AND va2.apresentadora_id = vr.apresentadora_id
      AND date_trunc('month', va2.data::timestamp) = date_trunc('month', vr.data::timestamp)
      AND NOT (va2.origem = 'video' AND va2.origem_id = vr.id)
  ) mensal ON true
  LEFT JOIN LATERAL (
    SELECT f.comissao_pct
    FROM apresentadora_comissao_faixas f
    WHERE f.tenant_id = vr.tenant_id
      AND f.apresentadora_id = vr.apresentadora_id
      AND f.ativo = true
      AND f.gmv_inicio <= mensal.gmv_mes
      AND (f.gmv_fim IS NULL OR f.gmv_fim >= mensal.gmv_mes)
    ORDER BY f.gmv_inicio DESC
    LIMIT 1
  ) faixa ON true
  WHERE COALESCE(vr.gmv_atribuido, 0) > 0
)
UPDATE vendas_atribuidas va
SET marca_id = vc.marca_id,
    apresentadora_id = vc.apresentadora_id,
    data = vc.data,
    gmv = vc.gmv,
    pedidos = vc.pedidos,
    comissao_apresentadora = vc.comissao_apresentadora,
    comissao_franquia = vc.comissao_franquia,
    comissao_franqueadora = vc.comissao_franqueadora,
    atualizado_em = NOW()
FROM video_calc vc
WHERE va.tenant_id = vc.tenant_id
  AND va.origem = vc.origem
  AND va.origem_id = vc.origem_id
  AND va.apresentadora_id IS NOT DISTINCT FROM vc.apresentadora_id
  AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') = 'pendente_aprovacao';

WITH video_calc AS (
  SELECT
    vr.tenant_id,
    'video'::text AS origem,
    vr.id AS origem_id,
    vr.marca_id,
    vr.apresentadora_id,
    vr.data,
    COALESCE(vr.gmv_atribuido, 0) AS gmv,
    COALESCE(vr.pedidos_atribuidos, 0) AS pedidos,
    COALESCE(vr.gmv_atribuido, 0)
      * (
        COALESCE(faixa.comissao_pct, NULLIF(am.comissao_video_pct, 0), NULLIF(a.comissao_pct, 0), 0)
        / 100.0
      ) AS comissao_apresentadora,
    COALESCE(vr.gmv_atribuido, 0) * (COALESCE(m.comissao_franquia_pct, 0) / 100.0) AS comissao_franquia,
    COALESCE(vr.gmv_atribuido, 0) * (COALESCE(m.comissao_franqueadora_pct, 0) / 100.0) AS comissao_franqueadora
  FROM video_registros vr
  JOIN marcas m
    ON m.id = vr.marca_id
   AND m.tenant_id = vr.tenant_id
  LEFT JOIN apresentadoras a
    ON a.id = vr.apresentadora_id
   AND a.tenant_id = vr.tenant_id
  LEFT JOIN apresentadora_marcas am
    ON am.tenant_id = vr.tenant_id
   AND am.marca_id = vr.marca_id
   AND am.apresentadora_id = vr.apresentadora_id
   AND am.ativo = true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(va2.gmv), 0) + COALESCE(vr.gmv_atribuido, 0) AS gmv_mes
    FROM vendas_atribuidas va2
    WHERE va2.tenant_id = vr.tenant_id
      AND va2.apresentadora_id = vr.apresentadora_id
      AND date_trunc('month', va2.data::timestamp) = date_trunc('month', vr.data::timestamp)
      AND NOT (va2.origem = 'video' AND va2.origem_id = vr.id)
  ) mensal ON true
  LEFT JOIN LATERAL (
    SELECT f.comissao_pct
    FROM apresentadora_comissao_faixas f
    WHERE f.tenant_id = vr.tenant_id
      AND f.apresentadora_id = vr.apresentadora_id
      AND f.ativo = true
      AND f.gmv_inicio <= mensal.gmv_mes
      AND (f.gmv_fim IS NULL OR f.gmv_fim >= mensal.gmv_mes)
    ORDER BY f.gmv_inicio DESC
    LIMIT 1
  ) faixa ON true
  WHERE COALESCE(vr.gmv_atribuido, 0) > 0
)
INSERT INTO vendas_atribuidas (
  tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
  gmv, pedidos, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
  status_aprovacao
)
SELECT
  vc.tenant_id, vc.origem, vc.origem_id, vc.marca_id, vc.apresentadora_id, vc.data,
  vc.gmv, vc.pedidos, vc.comissao_apresentadora, vc.comissao_franquia, vc.comissao_franqueadora,
  'pendente_aprovacao'
FROM video_calc vc
WHERE NOT EXISTS (
  SELECT 1
  FROM vendas_atribuidas va
  WHERE va.tenant_id = vc.tenant_id
    AND va.origem = vc.origem
    AND va.origem_id = vc.origem_id
    AND va.apresentadora_id IS NOT DISTINCT FROM vc.apresentadora_id
);
