-- Migration 116: muda a SEMÂNTICA de marcas.valor_fixo_minimo.
-- Antes: piso por live — comissao_franquia = MAX(valor_fixo_minimo, gmv*pct).
-- Agora: FIXO MENSAL que SOMA ao comissionamento — adicionado UMA vez por marca
--        tipo='cliente' por mês COM atividade, em franquia E franqueadora.
-- Não há mudança de dados: o valor já cadastrado passa a ser interpretado como
-- fixo mensal. Apenas atualiza o COMMENT da coluna para refletir a nova regra.

COMMENT ON COLUMN marcas.valor_fixo_minimo IS
  'Fixo mensal (R$) da marca tipo=cliente. SOMA ao comissionamento gerado uma vez '
  'por mês com atividade, em franquia e franqueadora. Afiliadas ignoram este campo. '
  '(Antes da migration 116 era um piso por live; ver comissao.js/performance-rollups.js.)';
