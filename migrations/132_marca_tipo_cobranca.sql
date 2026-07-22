-- Migration 132: tipo de cobrança por marca (fixo + comissão vs fixo OU comissão).
-- Antes: regra única global — desde a migration 116, ENTRADAS = comissão(gmv*pct) + fixo
--        mensal (valor_fixo_minimo) para TODAS as marcas (aditivo).
-- Agora: cada marca declara como o fixo e a comissão se combinam:
--        - fixo_mais_comissao (default): entrada = fixo_mensal + comissão   (preserva o atual)
--        - fixo_ou_comissao:             entrada = GREATEST(fixo_mensal, comissão)
-- Default preserva o comportamento vigente — nenhuma marca muda até ser marcada como "OU".

ALTER TABLE marcas
  ADD COLUMN IF NOT EXISTS tipo_cobranca TEXT NOT NULL DEFAULT 'fixo_mais_comissao';

-- CHECK idempotente (só cria se ainda não existe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marcas_tipo_cobranca_check'
  ) THEN
    ALTER TABLE marcas
      ADD CONSTRAINT marcas_tipo_cobranca_check
      CHECK (tipo_cobranca IN ('fixo_mais_comissao', 'fixo_ou_comissao'));
  END IF;
END $$;

COMMENT ON COLUMN marcas.tipo_cobranca IS
  'Regra de composição da entrada da marca: fixo_mais_comissao = valor_fixo_minimo + comissao(gmv*pct); '
  'fixo_ou_comissao = GREATEST(valor_fixo_minimo, comissao). Default fixo_mais_comissao preserva a regra '
  'aditiva vigente desde a migration 116.';
