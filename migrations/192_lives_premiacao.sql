ALTER TABLE lives
  ADD COLUMN premiacao NUMERIC(12,2)
  CONSTRAINT lives_premiacao_nao_negativa CHECK (premiacao >= 0);

COMMENT ON COLUMN lives.premiacao IS
  'Bonificação manual em reais por live de afiliado, separada de GMV e comissões.';
