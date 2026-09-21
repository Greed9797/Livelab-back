-- Cabine deixa de ser obrigatória para abrir ou registrar uma live.
-- A tabela cabines permanece. Linhas antigas conservam o id.
-- Lives e solicitações novas podem gravar cabine_id NULL.
-- O índice de overlap de agenda_eventos já ignora cabine_id nulo (migration 080).

ALTER TABLE lives
  ALTER COLUMN cabine_id DROP NOT NULL;

ALTER TABLE live_requests
  ALTER COLUMN cabine_id DROP NOT NULL;

COMMENT ON COLUMN lives.cabine_id IS
  'Opcional. Lives antigas conservam a cabine. Lives novas podem ficar sem estação.';

COMMENT ON COLUMN live_requests.cabine_id IS
  'Opcional. Solicitações antigas conservam a cabine.';
