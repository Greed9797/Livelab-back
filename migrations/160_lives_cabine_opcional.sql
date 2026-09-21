-- Cabine deixa de ser obrigatória para abrir ou registrar uma live.
-- A tabela cabines permanece. Linhas antigas conservam o id.
-- Lives novas podem gravar cabine_id NULL.
-- agenda_eventos.cabine_id já é opcional (migration 080).
-- live_requests deixou de ser tabela na migration 106 (virou view). Não alterar.

ALTER TABLE lives
  ALTER COLUMN cabine_id DROP NOT NULL;

COMMENT ON COLUMN lives.cabine_id IS
  'Opcional. Lives antigas conservam a cabine. Lives novas podem ficar sem estação.';
