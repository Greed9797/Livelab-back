-- 091_lives_agenda_link.sql
-- Unificação operacional: vínculo forte live ↔ agenda_evento + previsão de fim.
-- Idempotente.

-- 1) Colunas em lives
ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS agenda_evento_id UUID
    REFERENCES agenda_eventos(id) ON DELETE SET NULL;

ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS previsto_fim TIMESTAMPTZ NULL;

-- 2) Índice pra lookup por agenda
CREATE INDEX IF NOT EXISTS idx_lives_agenda_evento_id
  ON lives(agenda_evento_id)
  WHERE agenda_evento_id IS NOT NULL;

-- 3) Índice pra checar live ativa por cabine (usado em liberar cabine)
CREATE INDEX IF NOT EXISTS idx_lives_cabine_em_andamento
  ON lives(tenant_id, cabine_id)
  WHERE status = 'em_andamento';

-- 4) Backfill heurístico: linka lives existentes ao evento de agenda mais próximo
--    Critério: mesma cabine + mesmo tenant + data_inicio dentro de ±2h do iniciado_em
--    Só atualiza lives sem vínculo prévio.
DO $$
BEGIN
  UPDATE lives l
  SET agenda_evento_id = sub.evento_id
  FROM (
    SELECT DISTINCT ON (l2.id)
           l2.id AS live_id,
           ae.id AS evento_id
    FROM lives l2
    JOIN agenda_eventos ae
      ON ae.tenant_id = l2.tenant_id
     AND ae.cabine_id = l2.cabine_id
     AND ae.tipo = 'live'
     AND ABS(EXTRACT(EPOCH FROM (ae.data_inicio - l2.iniciado_em))) < 7200
    WHERE l2.agenda_evento_id IS NULL
      AND l2.iniciado_em IS NOT NULL
      AND l2.cabine_id IS NOT NULL
    ORDER BY l2.id, ABS(EXTRACT(EPOCH FROM (ae.data_inicio - l2.iniciado_em))) ASC
  ) sub
  WHERE l.id = sub.live_id;
END $$;

-- 5) Backfill previsto_fim quando vínculo existe
UPDATE lives l
SET previsto_fim = ae.data_fim
FROM agenda_eventos ae
WHERE l.agenda_evento_id = ae.id
  AND l.previsto_fim IS NULL
  AND ae.data_fim IS NOT NULL;

-- 6) Constraint soft via trigger: lives em_andamento devem ter apresentador_id ou apresentadora vinculada
--    Não usa CHECK porque verifica tabela relacionada (live_apresentadoras_v2).
CREATE OR REPLACE FUNCTION enforce_live_apresentadora_em_andamento()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'em_andamento' THEN
    IF NEW.apresentador_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM live_apresentadoras_v2
         WHERE live_id = NEW.id
       )
    THEN
      -- Soft warning via NOTICE; aplicação deve garantir apresentadora.
      -- Mantém compat com dados legados sem quebrar inserções.
      RAISE NOTICE 'live % em_andamento sem apresentador_id nem live_apresentadoras_v2', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_live_apresentadora ON lives;
CREATE TRIGGER trg_enforce_live_apresentadora
  AFTER INSERT OR UPDATE OF status ON lives
  FOR EACH ROW
  EXECUTE FUNCTION enforce_live_apresentadora_em_andamento();

-- 7) Comentário documental
COMMENT ON COLUMN lives.agenda_evento_id IS
  'FK opcional para agenda_eventos. Quando preenchido, live nasceu de evento agendado. Quando NULL com origem manual/auto, evento foi criado retroativamente.';

COMMENT ON COLUMN lives.previsto_fim IS
  'Horário previsto de término informado no início da live. Distinto de encerrado_em (real).';
