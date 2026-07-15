-- Migration 121: arquivamento de entidades (ocultar sem excluir), estado distinto
-- de inativa/pausada. Clientes já têm status 'arquivado' no CHECK (migration 016+).

-- marcas: adicionar 'arquivada' ao CHECK de status.
ALTER TABLE marcas DROP CONSTRAINT IF EXISTS marcas_status_check;
ALTER TABLE marcas
  ADD CONSTRAINT marcas_status_check
  CHECK (status IN ('ativa', 'inativa', 'pausada', 'arquivada'));

-- apresentadoras: coluna 'arquivada' distinta de 'ativo' (ativo = pausar temporário).
ALTER TABLE apresentadoras
  ADD COLUMN IF NOT EXISTS arquivada BOOLEAN NOT NULL DEFAULT false;

-- Índice parcial: consultas default filtram arquivada = false.
CREATE INDEX IF NOT EXISTS idx_apresentadoras_arquivada
  ON apresentadoras(tenant_id) WHERE arquivada = false;
