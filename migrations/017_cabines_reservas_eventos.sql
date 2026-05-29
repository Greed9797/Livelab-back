-- Cabines operacionais: reserva, ativacao e trilha de auditoria

ALTER TABLE cabines
  ADD COLUMN IF NOT EXISTS contrato_id UUID REFERENCES contratos(id);

-- Tenta recuperar o vinculo contratual a partir da live atual, quando existir.
UPDATE cabines c
SET contrato_id = ct.id
FROM lives l
JOIN contratos ct
  ON ct.cliente_id = l.cliente_id
 AND ct.tenant_id = l.tenant_id
 AND ct.status = 'ativo'
WHERE c.live_atual_id = l.id
  AND c.contrato_id IS NULL;

-- Normaliza estados antigos/inconsistentes antes de reforcar constraints.
UPDATE cabines
SET status = 'disponivel',
    live_atual_id = NULL,
    contrato_id = NULL
WHERE status = 'ao_vivo'
  AND (live_atual_id IS NULL OR contrato_id IS NULL);

ALTER TABLE cabines DROP CONSTRAINT IF EXISTS cabines_status_check;
ALTER TABLE cabines
  ADD CONSTRAINT cabines_status_check
  CHECK (status IN ('disponivel', 'reservada', 'ativa', 'ao_vivo', 'manutencao'));

ALTER TABLE cabines DROP CONSTRAINT IF EXISTS cabines_status_contrato_check;
ALTER TABLE cabines
  ADD CONSTRAINT cabines_status_contrato_check
  CHECK (
    (
      status IN ('reservada', 'ativa', 'ao_vivo')
      AND contrato_id IS NOT NULL
    )
    OR (
      status IN ('disponivel', 'manutencao')
      AND contrato_id IS NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_cabines_contrato_vinculado
  ON cabines(contrato_id)
  WHERE contrato_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cabine_eventos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  cabine_id      UUID NOT NULL REFERENCES cabines(id) ON DELETE CASCADE,
  contrato_id    UUID REFERENCES contratos(id),
  tipo_evento    TEXT NOT NULL CHECK (tipo_evento IN (
    'cabine_reservada',
    'cabine_liberada',
    'cabine_ativada',
    'cabine_live_iniciada',
    'cabine_live_encerrada',
    'cabine_manutencao'
  )),
  actor_user_id  UUID REFERENCES users(id),
  actor_papel    TEXT,
  ip             TEXT,
  payload_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cabine_eventos_cabine
  ON cabine_eventos(cabine_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cabine_eventos_tipo
  ON cabine_eventos(tipo_evento, created_at DESC);

ALTER TABLE cabine_eventos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cabine_eventos_tenant ON cabine_eventos;
CREATE POLICY cabine_eventos_tenant ON cabine_eventos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE OR REPLACE FUNCTION prevent_cabine_eventos_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cabine_eventos is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_cabine_eventos_update ON cabine_eventos;
CREATE TRIGGER trg_prevent_cabine_eventos_update
BEFORE UPDATE ON cabine_eventos
FOR EACH ROW EXECUTE FUNCTION prevent_cabine_eventos_mutation();

DROP TRIGGER IF EXISTS trg_prevent_cabine_eventos_delete ON cabine_eventos;
CREATE TRIGGER trg_prevent_cabine_eventos_delete
BEFORE DELETE ON cabine_eventos
FOR EACH ROW EXECUTE FUNCTION prevent_cabine_eventos_mutation();

CREATE OR REPLACE FUNCTION sync_cabines_when_contrato_leaves_active()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ativo' AND NEW.status <> 'ativo' THEN
    INSERT INTO cabine_eventos (
      tenant_id,
      cabine_id,
      contrato_id,
      tipo_evento,
      payload_json
    )
    SELECT
      c.tenant_id,
      c.id,
      c.contrato_id,
      'cabine_liberada',
      jsonb_build_object(
        'motivo', 'contrato_status_changed',
        'status_anterior', OLD.status,
        'status_novo', NEW.status
      )
    FROM cabines c
    WHERE c.contrato_id = NEW.id
      AND c.status IN ('reservada', 'ativa');

    UPDATE cabines
    SET status = 'disponivel',
        contrato_id = NULL,
        live_atual_id = NULL
    WHERE contrato_id = NEW.id
      AND status IN ('reservada', 'ativa');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_cabines_when_contrato_leaves_active ON contratos;
CREATE TRIGGER trg_sync_cabines_when_contrato_leaves_active
AFTER UPDATE OF status ON contratos
FOR EACH ROW EXECUTE FUNCTION sync_cabines_when_contrato_leaves_active();
