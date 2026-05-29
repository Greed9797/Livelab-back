-- Migration 106: Deprecar live_requests → agenda_eventos
-- Estratégia conservadora: backfill dados, renomear tabela, criar view de compat
--
-- Schema confirmado (migration 025 + 040):
--   live_requests: id, tenant_id, cabine_id, cliente_id, solicitante_id,
--                  data_solicitada DATE, hora_inicio TIME, hora_fim TIME,
--                  observacao TEXT, status ('pendente','aprovada','recusada'),
--                  motivo_recusa TEXT, aprovado_por UUID, apresentadora_id UUID,
--                  criado_em TIMESTAMPTZ, atualizado_em TIMESTAMPTZ
--
-- Schema destino (migration 080):
--   agenda_eventos: id, tenant_id, tipo, marca_id, cabine_id,
--                   data_inicio TIMESTAMPTZ, data_fim TIMESTAMPTZ,
--                   status ('planejado','confirmado','ao_vivo','concluido','cancelado'),
--                   observacoes TEXT, criado_por UUID,
--                   criado_em TIMESTAMPTZ, atualizado_em TIMESTAMPTZ

-- 1. Backfill: inserir live_requests pendentes/aprovadas em agenda_eventos (idempotente via ON CONFLICT)
INSERT INTO agenda_eventos (
  id,
  tenant_id,
  tipo,
  marca_id,
  cabine_id,
  data_inicio,
  data_fim,
  status,
  observacoes,
  criado_por,
  criado_em,
  atualizado_em
)
SELECT
  lr.id,
  lr.tenant_id,
  'live',
  COALESCE(
    -- Primeira marca ativa do cliente neste tenant
    (SELECT m.id FROM marcas m
     WHERE m.tenant_id = lr.tenant_id
       AND m.cliente_id = lr.cliente_id
       AND m.status = 'ativa'
     ORDER BY m.criado_em ASC LIMIT 1),
    -- Fallback: marca sistema do tenant (criada em migration 104)
    (SELECT m.id FROM marcas m
     WHERE m.tenant_id = lr.tenant_id AND m.sistema = TRUE LIMIT 1)
  ) AS marca_id,
  lr.cabine_id,
  (lr.data_solicitada + lr.hora_inicio)::timestamptz AS data_inicio,
  (lr.data_solicitada + lr.hora_fim)::timestamptz   AS data_fim,
  CASE lr.status
    WHEN 'pendente'  THEN 'planejado'
    WHEN 'aprovada'  THEN 'confirmado'
    WHEN 'recusada'  THEN 'cancelado'
  END AS status,
  lr.observacao,
  lr.solicitante_id,
  lr.criado_em,
  lr.atualizado_em
FROM live_requests lr
WHERE lr.status IN ('pendente', 'aprovada')
ON CONFLICT (id) DO NOTHING;

-- 2. Renomear tabela (preservar dados históricos, não dropar)
ALTER TABLE live_requests RENAME TO live_requests_deprecated;
COMMENT ON TABLE live_requests_deprecated IS
  'DEPRECATED — migrado para agenda_eventos em migration 106. '
  'Não inserir novos registros. Drop planejado após verificação de uso em produção.';

-- 3. View de compatibilidade live_requests (read-only) para código legado
--    Reconstruída a partir de agenda_eventos WHERE tipo = ''live''
CREATE OR REPLACE VIEW live_requests AS
SELECT
  ae.id,
  ae.tenant_id,
  -- cliente_id derivado da marca vinculada ao evento
  (SELECT m.cliente_id FROM marcas m WHERE m.id = ae.marca_id) AS cliente_id,
  ae.cabine_id,
  ae.data_inicio::date           AS data_solicitada,
  ae.data_inicio::time           AS hora_inicio,
  ae.data_fim::time              AS hora_fim,
  CASE ae.status
    WHEN 'planejado'  THEN 'pendente'
    WHEN 'confirmado' THEN 'aprovada'
    WHEN 'cancelado'  THEN 'recusada'
    ELSE 'pendente'
  END                            AS status,
  ae.observacoes                 AS observacao,
  ae.criado_por                  AS solicitante_id,
  ae.criado_em,
  ae.atualizado_em
FROM agenda_eventos ae
WHERE ae.tipo = 'live';
