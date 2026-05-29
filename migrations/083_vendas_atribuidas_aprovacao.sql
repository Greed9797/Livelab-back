-- Migration 083: fluxo de aprovação de comissões em vendas_atribuidas
-- Adiciona status de aprovação, rastreio de aprovador e motivo de reprovação

ALTER TABLE vendas_atribuidas
  ADD COLUMN IF NOT EXISTS status_aprovacao TEXT NOT NULL DEFAULT 'pendente_aprovacao'
    CHECK (status_aprovacao IN ('pendente_aprovacao', 'aprovada', 'reprovada')),
  ADD COLUMN IF NOT EXISTS status_motivo TEXT,
  ADD COLUMN IF NOT EXISTS aprovado_por UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS aprovado_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_vendas_atribuidas_status_aprovacao
  ON vendas_atribuidas(tenant_id, status_aprovacao)
  WHERE status_aprovacao = 'pendente_aprovacao';

-- ============================================================================
-- Fim da migration 083
-- ============================================================================
