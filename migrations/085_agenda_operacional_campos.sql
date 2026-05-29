-- Agenda operacional por cabine: permite bloqueios e vinculo opcional de apresentadora.

ALTER TABLE agenda_eventos
  ALTER COLUMN marca_id DROP NOT NULL;

ALTER TABLE agenda_eventos
  ADD COLUMN IF NOT EXISTS apresentadora_id UUID REFERENCES apresentadoras(id),
  ADD COLUMN IF NOT EXISTS responsavel_marketing TEXT;

ALTER TABLE agenda_eventos DROP CONSTRAINT IF EXISTS agenda_eventos_tipo_check;
ALTER TABLE agenda_eventos
  ADD CONSTRAINT agenda_eventos_tipo_check
  CHECK (tipo IN ('live', 'gravacao_video', 'bloqueio_manutencao'));

CREATE INDEX IF NOT EXISTS idx_agenda_eventos_apresentadora
  ON agenda_eventos(tenant_id, apresentadora_id, data_inicio)
  WHERE apresentadora_id IS NOT NULL;
