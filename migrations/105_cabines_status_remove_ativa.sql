-- Migration 105: Remove status 'ativa' da tabela cabines
-- Status válidos após: disponivel | reservada | ao_vivo | manutencao
-- 'ativa' era um estado ambíguo que duplicava informação de lives.em_andamento

-- 1. Migrar cabines com status='ativa' para 'disponivel'
UPDATE cabines SET status = 'disponivel' WHERE status = 'ativa';

-- 2. Também garantir em agenda_eventos (defesa, caso exista)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agenda_eventos' AND column_name = 'status'
  ) THEN
    UPDATE agenda_eventos SET status = 'planejado' WHERE status = 'ativa';
  END IF;
END $$;

-- 3. Rebuild do CHECK constraint sem 'ativa'
ALTER TABLE cabines DROP CONSTRAINT IF EXISTS cabines_status_check;
ALTER TABLE cabines ADD CONSTRAINT cabines_status_check
  CHECK (status IN ('disponivel', 'reservada', 'ao_vivo', 'manutencao'));

-- 4. Verificação final: deve ser 0 linhas
DO $$
DECLARE
  cnt integer;
BEGIN
  SELECT COUNT(*) INTO cnt FROM cabines WHERE status = 'ativa';
  IF cnt > 0 THEN
    RAISE EXCEPTION 'Migration 105 falhou: ainda existem % cabines com status=ativa', cnt;
  END IF;
END $$;
