-- API-key confirms store origem = 'bot'. Migration 151 only allowed
-- gestao, importacao, legado_nao_verificado, and correcao.
ALTER TABLE marca_condicoes_comerciais
  DROP CONSTRAINT IF EXISTS marca_condicoes_origem_check;

ALTER TABLE marca_condicoes_comerciais
  ADD CONSTRAINT marca_condicoes_origem_check
  CHECK (origem IN ('gestao', 'importacao', 'legado_nao_verificado', 'correcao', 'bot'));
