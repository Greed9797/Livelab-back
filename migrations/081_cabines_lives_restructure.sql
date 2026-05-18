-- Migration 081: Reestruturação de cabines e lives
-- Objetivo:
--   1. Remover status 'ativa' das cabines (normalizar para 'disponivel')
--   2. Tornar lives.cliente_id nullable (suporta afiliado/teste sem cliente)
--   3. Adicionar coluna tipo em lives (cliente|afiliado|teste)
--   4. Adicionar coluna status_publicacao em lives (rascunho|revisado|publicado)
--   5. Adicionar coluna origem_dados em lives (manual|api)

-- ============================================================================
-- 1. CABINES: Remover status 'ativa' e migrar para 'disponivel'
-- ============================================================================

-- Migração de dados: cabines com status 'ativa' → 'disponivel'
-- contrato_id é zerado pois 'ativa' era o estado "reservada + contrato vinculado"
UPDATE cabines
SET status = 'disponivel',
    contrato_id = NULL
WHERE status = 'ativa';

-- Recriar constraint sem 'ativa'
ALTER TABLE cabines DROP CONSTRAINT IF EXISTS cabines_status_check;
ALTER TABLE cabines
  ADD CONSTRAINT cabines_status_check
  CHECK (status IN ('disponivel', 'reservada', 'ao_vivo', 'manutencao'));

-- NOTA: contrato_id permanece na tabela para compatibilidade histórica.
-- O vínculo contrato→cabine não é mais obrigatório; a coluna existe apenas
-- para manter referência em cabine_eventos e dados legados.

-- ============================================================================
-- 2. LIVES: Tornar cliente_id nullable
-- ============================================================================
-- Suporta lives de tipo afiliado/teste sem cliente associado
ALTER TABLE lives ALTER COLUMN cliente_id DROP NOT NULL;

-- ============================================================================
-- 3. LIVES: Adicionar coluna tipo (cliente|afiliado|teste)
-- ============================================================================
-- Define o tipo de live para contexto de faturamento e comissão
ALTER TABLE lives ADD COLUMN IF NOT EXISTS tipo TEXT
  NOT NULL DEFAULT 'cliente'
  CHECK (tipo IN ('cliente', 'afiliado', 'teste'));

-- ============================================================================
-- 4. LIVES: Adicionar coluna status_publicacao (rascunho|revisado|publicado)
-- ============================================================================
-- Controla o status editorial da live (se pode ser publicada, exibida ao vivo, etc)
ALTER TABLE lives ADD COLUMN IF NOT EXISTS status_publicacao TEXT
  NOT NULL DEFAULT 'rascunho'
  CHECK (status_publicacao IN ('rascunho', 'revisado', 'publicado'));

-- ============================================================================
-- 5. LIVES: Adicionar coluna origem_dados (manual|api)
-- ============================================================================
-- Rastreia se a live foi criada manualmente (dashboard) ou via API/integração
ALTER TABLE lives ADD COLUMN IF NOT EXISTS origem_dados TEXT
  NOT NULL DEFAULT 'manual'
  CHECK (origem_dados IN ('manual', 'api'));

-- ============================================================================
-- Fim da migration 081
-- ============================================================================
