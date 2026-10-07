-- Aditiva: não cancela cobranças nem altera fatos ou valores existentes.
-- A suspensão administrativa de uma competência não é perda nem estorno.
ALTER TABLE receita_titulos
  ADD COLUMN IF NOT EXISTS suspensao_comercial JSONB NULL;

COMMENT ON COLUMN receita_titulos.suspensao_comercial IS
  'Suspensão administrativa do saldo aberto por correção de condição comercial; preserva valores brutos, perdas, liquidações e identidade do título. NULL significa cobrança comercial ativa.';
