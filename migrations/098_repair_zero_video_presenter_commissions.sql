-- Reparo complementar: vídeos não reprovados que ficaram com comissão da
-- apresentadora zerada devem refletir a faixa/vínculo/perfil vigente.
-- Isso cobre registros que já tinham sido aprovados com 0 por causa do bug.

WITH video_calc AS (
  SELECT
    va.id AS venda_id,
    va.tenant_id,
    COALESCE(vr.gmv_atribuido, va.gmv, 0) AS gmv,
    COALESCE(vr.pedidos_atribuidos, va.pedidos, 0) AS pedidos,
    COALESCE(vr.gmv_atribuido, va.gmv, 0)
      * (
        COALESCE(faixa.comissao_pct, NULLIF(am.comissao_video_pct, 0), NULLIF(a.comissao_pct, 0), 0)
        / 100.0
      ) AS comissao_apresentadora,
    COALESCE(vr.gmv_atribuido, va.gmv, 0) * (COALESCE(m.comissao_franquia_pct, 0) / 100.0) AS comissao_franquia,
    COALESCE(vr.gmv_atribuido, va.gmv, 0) * (COALESCE(m.comissao_franqueadora_pct, 0) / 100.0) AS comissao_franqueadora
  FROM vendas_atribuidas va
  LEFT JOIN video_registros vr
    ON vr.tenant_id = va.tenant_id
   AND vr.id = va.origem_id
  JOIN marcas m
    ON m.id = COALESCE(vr.marca_id, va.marca_id)
   AND m.tenant_id = va.tenant_id
  LEFT JOIN apresentadoras a
    ON a.id = COALESCE(vr.apresentadora_id, va.apresentadora_id)
   AND a.tenant_id = va.tenant_id
  LEFT JOIN apresentadora_marcas am
    ON am.tenant_id = va.tenant_id
   AND am.marca_id = COALESCE(vr.marca_id, va.marca_id)
   AND am.apresentadora_id = COALESCE(vr.apresentadora_id, va.apresentadora_id)
   AND am.ativo = true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(va2.gmv), 0) AS gmv_mes
    FROM vendas_atribuidas va2
    WHERE va2.tenant_id = va.tenant_id
      AND va2.apresentadora_id = COALESCE(vr.apresentadora_id, va.apresentadora_id)
      AND date_trunc('month', va2.data::timestamp) = date_trunc('month', COALESCE(vr.data, va.data)::timestamp)
  ) mensal ON true
  LEFT JOIN LATERAL (
    SELECT f.comissao_pct
    FROM apresentadora_comissao_faixas f
    WHERE f.tenant_id = va.tenant_id
      AND f.apresentadora_id = COALESCE(vr.apresentadora_id, va.apresentadora_id)
      AND f.ativo = true
      AND f.gmv_inicio <= mensal.gmv_mes
      AND (f.gmv_fim IS NULL OR f.gmv_fim >= mensal.gmv_mes)
    ORDER BY f.gmv_inicio DESC
    LIMIT 1
  ) faixa ON true
  WHERE va.origem = 'video'
    AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
    AND COALESCE(va.comissao_apresentadora, 0) = 0
    AND COALESCE(vr.gmv_atribuido, va.gmv, 0) > 0
    AND COALESCE(vr.apresentadora_id, va.apresentadora_id) IS NOT NULL
)
UPDATE vendas_atribuidas va
SET gmv = vc.gmv,
    pedidos = vc.pedidos,
    comissao_apresentadora = vc.comissao_apresentadora,
    comissao_franquia = vc.comissao_franquia,
    comissao_franqueadora = vc.comissao_franqueadora,
    atualizado_em = NOW()
FROM video_calc vc
WHERE va.id = vc.venda_id
  AND va.tenant_id = vc.tenant_id
  AND vc.comissao_apresentadora > 0;
