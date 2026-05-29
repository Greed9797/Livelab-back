-- Adiciona coluna onboarding_step e expande CHECK de status para incluir 'onboarding'

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 0;

-- Expande o CHECK de status para incluir 'onboarding'
ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_status_check;
ALTER TABLE clientes
  ADD CONSTRAINT clientes_status_check
  CHECK (status IN (
    'negociacao',
    'enviado',
    'em_analise',
    'pendencia_comercial',
    'aprovado',
    'onboarding',
    'ativo',
    'risco_assumido',
    'reprovado',
    'inadimplente',
    'arquivado',
    'cancelado',
    'cancelado_automaticamente'
  ));
