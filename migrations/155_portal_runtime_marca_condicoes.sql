-- O fluxo de aprovação roda com a role isolada do portal e o motor de comissão
-- consulta a condição comercial vigente. A tabela nasceu depois da role; sem
-- este grant, criar a live histórica falha com PostgreSQL 42501.
GRANT SELECT (
  id,
  tenant_id,
  marca_id,
  inicio_vigencia,
  fixo_mensal,
  comissao_franquia_pct,
  comissao_franqueadora_pct,
  tipo_cobranca,
  fixo_confirmado,
  comissao_confirmada,
  origem,
  cancelled_at
) ON marca_condicoes_comerciais TO livelab_portal_runtime;
