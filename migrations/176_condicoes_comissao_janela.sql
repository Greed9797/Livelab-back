-- 176 — Janela de apuração da comissão por condição comercial.
-- comissao_janela_inicio_dia = dia do mês em que a janela começa (1 = mês civil, comportamento atual).
-- Competência = mês em que a janela começa (ex.: 16 => 16/set..15/out é competência setembro).
-- Idempotente.

ALTER TABLE marca_condicoes_comerciais
  ADD COLUMN IF NOT EXISTS comissao_janela_inicio_dia SMALLINT NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marca_condicoes_comissao_janela_check') THEN
    ALTER TABLE marca_condicoes_comerciais ADD CONSTRAINT marca_condicoes_comissao_janela_check
      CHECK (comissao_janela_inicio_dia BETWEEN 1 AND 28);
  END IF;
END $$;

COMMENT ON COLUMN marca_condicoes_comerciais.comissao_janela_inicio_dia IS 'Dia (1..28) em que a janela de apuração da comissão começa; 1 = mês civil. Competência = mês do início da janela.';
