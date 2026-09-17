-- Migration 155 initially included condition fields unused by portal approval.
-- Keep the isolated runtime role limited to the commission lookup it executes.
REVOKE SELECT (
  fixo_mensal,
  tipo_cobranca,
  fixo_confirmado,
  comissao_confirmada,
  origem
) ON marca_condicoes_comerciais FROM livelab_portal_runtime;
