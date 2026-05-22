-- Default oficial de remuneracao das apresentadoras.
-- Fixo mensal: R$ 2.700,00.
-- Comissao variavel por GMV mensal atribuido:
--   0,00 a 50.000,00       => 0,5%
--   50.000,01 a 150.000,00 => 1%
--   150.000,01 a 500.000,00 => 1,5%
--   acima de 500.000,00    => 2%

ALTER TABLE apresentadoras
  ALTER COLUMN fixo SET DEFAULT 2700;

UPDATE apresentadoras
SET fixo = 2700
WHERE COALESCE(fixo, 0) = 0;

WITH presenters AS (
  SELECT tenant_id, id AS apresentadora_id
  FROM apresentadoras
)
INSERT INTO apresentadora_comissao_faixas (
  tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo
)
SELECT
  p.tenant_id,
  p.apresentadora_id,
  tier.gmv_inicio,
  tier.gmv_fim,
  tier.comissao_pct,
  true
FROM presenters p
CROSS JOIN (
  VALUES
    (0::numeric, 50000::numeric, 0.5::numeric),
    (50000.01::numeric, 150000::numeric, 1::numeric),
    (150000.01::numeric, 500000::numeric, 1.5::numeric),
    (500000.01::numeric, NULL::numeric, 2::numeric)
) AS tier(gmv_inicio, gmv_fim, comissao_pct)
WHERE NOT EXISTS (
  SELECT 1
  FROM apresentadora_comissao_faixas f
  WHERE f.tenant_id = p.tenant_id
    AND f.apresentadora_id = p.apresentadora_id
    AND f.ativo = true
);

WITH vendas_calc AS (
  SELECT
    va.id AS venda_id,
    va.tenant_id,
    va.origem,
    COALESCE(vr.gmv_atribuido, va.gmv, 0) AS gmv,
    COALESCE(vr.pedidos_atribuidos, va.pedidos, 0) AS pedidos,
    COALESCE(vr.data, va.data) AS data_ref,
    COALESCE(vr.apresentadora_id, va.apresentadora_id) AS apresentadora_id,
    (
      CASE
        WHEN va.origem = 'live'
          AND EXTRACT(ISODOW FROM COALESCE(vr.data, va.data)::date) IN (6, 7)
          THEN 2
        WHEN faixa.comissao_pct IS NOT NULL
          THEN GREATEST(CASE WHEN va.origem = 'live' THEN 0.5 ELSE 0 END, faixa.comissao_pct)
        WHEN va.origem = 'video' AND NULLIF(am.comissao_video_pct, 0) IS NOT NULL
          THEN am.comissao_video_pct
        WHEN va.origem = 'live' AND NULLIF(am.comissao_live_pct, 0) IS NOT NULL
          THEN GREATEST(0.5, am.comissao_live_pct)
        WHEN NULLIF(a.comissao_pct, 0) IS NOT NULL
          THEN GREATEST(CASE WHEN va.origem = 'live' THEN 0.5 ELSE 0 END, a.comissao_pct)
        WHEN mensal.gmv_mes <= 50000
          THEN 0.5
        WHEN mensal.gmv_mes <= 150000
          THEN 1
        WHEN mensal.gmv_mes <= 500000
          THEN 1.5
        ELSE 2
      END
    ) AS apresentadora_pct,
    COALESCE(m.comissao_franquia_pct, 0) AS comissao_franquia_pct,
    COALESCE(m.comissao_franqueadora_pct, 0) AS comissao_franqueadora_pct
  FROM vendas_atribuidas va
  LEFT JOIN video_registros vr
    ON va.origem = 'video'
   AND vr.tenant_id = va.tenant_id
   AND vr.id = va.origem_id
  JOIN marcas m
    ON m.id = COALESCE(vr.marca_id, va.marca_id)
   AND m.tenant_id = va.tenant_id
  JOIN apresentadoras a
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
      AND COALESCE(va2.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
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
  WHERE va.origem IN ('live', 'video')
    AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
    AND COALESCE(va.comissao_apresentadora, 0) = 0
    AND COALESCE(vr.gmv_atribuido, va.gmv, 0) > 0
    AND COALESCE(vr.apresentadora_id, va.apresentadora_id) IS NOT NULL
)
UPDATE vendas_atribuidas va
SET gmv = vc.gmv,
    pedidos = vc.pedidos,
    apresentadora_id = vc.apresentadora_id,
    comissao_apresentadora = vc.gmv * (vc.apresentadora_pct / 100.0),
    comissao_franquia = vc.gmv * (vc.comissao_franquia_pct / 100.0),
    comissao_franqueadora = vc.gmv * (vc.comissao_franqueadora_pct / 100.0),
    atualizado_em = NOW()
FROM vendas_calc vc
WHERE va.id = vc.venda_id
  AND va.tenant_id = vc.tenant_id
  AND vc.apresentadora_pct > 0;
