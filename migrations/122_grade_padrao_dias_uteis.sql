-- Migration 122: padrão da grade passa a ser único para dias úteis (seg–sex).
-- A UI agora edita "Seg–Sex" como um bloco só (grava nos dows 1..5 de uma vez).
-- Sem esta normalização, uma terça com padrão divergente continuaria resolvendo
-- diferente do que a tela mostra (a tela exibe o padrão de segunda como representativo).
--
-- Regra: só mexe em tenants que TÊM padrão em segunda (dia_semana = 1).
-- Tenants sem segunda ficam intactos (nada a replicar).
-- Sábado (6) e domingo (0) não são tocados — seguem com padrão próprio.

DELETE FROM grade_padrao gp
WHERE gp.dia_semana IN (2, 3, 4, 5)
  AND EXISTS (
    SELECT 1 FROM grade_padrao seg
    WHERE seg.tenant_id = gp.tenant_id AND seg.dia_semana = 1
  );

INSERT INTO grade_padrao (
  tenant_id, dia_semana, cabine_id, hora_inicio, hora_fim,
  marca_id, apresentadora_id, observacao
)
SELECT seg.tenant_id, dow, seg.cabine_id, seg.hora_inicio, seg.hora_fim,
       seg.marca_id, seg.apresentadora_id, seg.observacao
FROM grade_padrao seg
CROSS JOIN unnest(ARRAY[2, 3, 4, 5]) AS dow
WHERE seg.dia_semana = 1
ON CONFLICT (tenant_id, dia_semana, cabine_id, hora_inicio) DO NOTHING;
