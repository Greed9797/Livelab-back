-- Garante que lives encerradas/em andamento tenham evento de agenda vinculado.
-- Corrige registros manuais antigos que ficaram apenas em lives e sumiram do calendário.

UPDATE lives l
   SET marca_id = COALESCE(
     (
       SELECT va2.marca_id
         FROM vendas_atribuidas va2
        WHERE va2.tenant_id = l.tenant_id
          AND va2.origem = 'live'
          AND va2.origem_id = l.id
          AND va2.marca_id IS NOT NULL
        ORDER BY va2.atualizado_em DESC NULLS LAST, va2.criado_em DESC NULLS LAST
        LIMIT 1
     ),
     (
       SELECT m2.id
         FROM marcas m2
        WHERE m2.tenant_id = l.tenant_id
          AND m2.cliente_id = l.cliente_id
          AND m2.status = 'ativa'
        ORDER BY m2.criado_em ASC
        LIMIT 1
     )
   )
 WHERE l.marca_id IS NULL
   AND COALESCE(
     (
       SELECT va2.marca_id
         FROM vendas_atribuidas va2
        WHERE va2.tenant_id = l.tenant_id
          AND va2.origem = 'live'
          AND va2.origem_id = l.id
          AND va2.marca_id IS NOT NULL
        ORDER BY va2.atualizado_em DESC NULLS LAST, va2.criado_em DESC NULLS LAST
        LIMIT 1
     ),
     (
       SELECT m2.id
         FROM marcas m2
        WHERE m2.tenant_id = l.tenant_id
          AND m2.cliente_id = l.cliente_id
          AND m2.status = 'ativa'
        ORDER BY m2.criado_em ASC
        LIMIT 1
     )
   ) IS NOT NULL;

WITH live_source AS (
  SELECT l.id,
         l.tenant_id,
         l.cabine_id,
         l.marca_id,
         l.agenda_evento_id,
         l.iniciado_em,
         CASE
           WHEN COALESCE(l.encerrado_em, l.previsto_fim, l.iniciado_em + INTERVAL '4 hours') > l.iniciado_em
             THEN COALESCE(l.encerrado_em, l.previsto_fim, l.iniciado_em + INTERVAL '4 hours')
           ELSE l.iniciado_em + INTERVAL '4 hours'
         END AS data_fim,
         CASE
           WHEN l.status = 'em_andamento' THEN 'ao_vivo'
           WHEN l.status = 'encerrada' THEN 'concluido'
           WHEN l.status = 'cancelada' THEN 'cancelado'
           ELSE 'planejado'
         END AS agenda_status,
         COALESCE(v2.apresentadora_id, ap.id) AS apresentadora_id,
         l.gestor_id AS criado_por
    FROM lives l
    LEFT JOIN LATERAL (
      SELECT lav.apresentadora_id
        FROM live_apresentadoras_v2 lav
       WHERE lav.tenant_id = l.tenant_id
         AND lav.live_id = l.id
       ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
       LIMIT 1
    ) v2 ON true
    LEFT JOIN apresentadoras ap
      ON ap.tenant_id = l.tenant_id
     AND ap.user_id = l.apresentador_id
   WHERE l.marca_id IS NOT NULL
     AND l.iniciado_em IS NOT NULL
     AND l.status IN ('em_andamento', 'encerrada')
),
candidates AS (
  SELECT DISTINCT ON (ls.id)
         ls.id AS live_id,
         ae.id AS evento_id
    FROM live_source ls
    JOIN agenda_eventos ae
      ON ae.tenant_id = ls.tenant_id
     AND ae.tipo = 'live'
     AND ae.status <> 'cancelado'
     AND (ae.live_id IS NULL OR ae.live_id = ls.id)
     AND (
       ae.id = ls.agenda_evento_id
       OR (
         ae.marca_id = ls.marca_id
         AND ae.cabine_id IS NOT DISTINCT FROM ls.cabine_id
         AND ae.data_inicio < ls.data_fim
         AND ae.data_fim > ls.iniciado_em
       )
     )
   ORDER BY ls.id, (ae.id = ls.agenda_evento_id) DESC,
            ABS(EXTRACT(EPOCH FROM (ae.data_inicio - ls.iniciado_em)))
),
updated AS (
  UPDATE agenda_eventos ae
     SET live_id = c.live_id,
         marca_id = ls.marca_id,
         cabine_id = ls.cabine_id,
         apresentadora_id = COALESCE(ae.apresentadora_id, ls.apresentadora_id),
         data_inicio = ls.iniciado_em,
         data_fim = ls.data_fim,
         status = ls.agenda_status,
         observacoes = COALESCE(NULLIF(ae.observacoes, ''), 'Live sincronizada retroativamente pelo vínculo operacional.'),
         atualizado_em = NOW()
    FROM candidates c
    JOIN live_source ls ON ls.id = c.live_id
   WHERE ae.id = c.evento_id
     AND ae.tenant_id = ls.tenant_id
   RETURNING ae.id, ae.live_id, ae.tenant_id
),
inserted AS (
  INSERT INTO agenda_eventos (
    tenant_id, tipo, marca_id, cabine_id, apresentadora_id, data_inicio, data_fim,
    status, live_id, observacoes, criado_por
  )
  SELECT ls.tenant_id,
         'live',
         ls.marca_id,
         ls.cabine_id,
         ls.apresentadora_id,
         ls.iniciado_em,
         ls.data_fim,
         ls.agenda_status,
         ls.id,
         'Live criada retroativamente a partir do registro operacional.',
         ls.criado_por
    FROM live_source ls
   WHERE NOT EXISTS (
     SELECT 1
       FROM updated u
      WHERE u.tenant_id = ls.tenant_id
        AND u.live_id = ls.id
   )
     AND NOT EXISTS (
       SELECT 1
         FROM agenda_eventos ae
        WHERE ae.tenant_id = ls.tenant_id
          AND (ae.live_id = ls.id OR ae.id = ls.agenda_evento_id)
     )
  RETURNING id, live_id, tenant_id
)
UPDATE lives l
   SET agenda_evento_id = linked.id
  FROM (
    SELECT id, live_id, tenant_id FROM updated
    UNION ALL
    SELECT id, live_id, tenant_id FROM inserted
  ) linked
 WHERE l.id = linked.live_id
   AND l.tenant_id = linked.tenant_id
   AND l.agenda_evento_id IS DISTINCT FROM linked.id;

UPDATE lives l
   SET agenda_evento_id = ae.id
  FROM agenda_eventos ae
 WHERE ae.tenant_id = l.tenant_id
   AND ae.live_id = l.id
   AND l.agenda_evento_id IS DISTINCT FROM ae.id;
