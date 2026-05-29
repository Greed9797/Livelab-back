-- Solicitações aprovadas para clientes SEM contrato ativo
-- Rodar antes do deploy para identificar órfãs que o novo fix bloquearia
SELECT
  lr.id                AS solicitacao_id,
  lr.tenant_id,
  lr.cabine_id,
  c.nome               AS cliente_nome,
  lr.cliente_id,
  lr.data_solicitada,
  lr.hora_inicio,
  lr.hora_fim,
  lr.status,
  (
    SELECT COUNT(*)
    FROM contratos ct
    WHERE ct.cliente_id = lr.cliente_id
      AND ct.tenant_id  = lr.tenant_id
      AND ct.status     = 'ativo'
  )                    AS contratos_ativos
FROM live_requests lr
JOIN clientes c ON c.id = lr.cliente_id
WHERE lr.status = 'aprovada'
  AND NOT EXISTS (
    SELECT 1
    FROM contratos ct
    WHERE ct.cliente_id = lr.cliente_id
      AND ct.tenant_id  = lr.tenant_id
      AND ct.status     = 'ativo'
  )
ORDER BY lr.data_solicitada DESC, lr.hora_inicio;
