-- migrations/015_geocoding_contratos.sql

-- Módulo 1: Geolocalização de clientes
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS cep        VARCHAR(9),
  ADD COLUMN IF NOT EXISTS logradouro TEXT,
  ADD COLUMN IF NOT EXISTS cidade     TEXT,
  ADD COLUMN IF NOT EXISTS estado     CHAR(2),
  ADD COLUMN IF NOT EXISTS siga       TEXT;

-- Módulo 3: Assinatura digital (Fase 1) + Slot Fase 2 (ZapSign)
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS signature_type        VARCHAR(10)  DEFAULT 'pad',
  ADD COLUMN IF NOT EXISTS external_signature_id TEXT,
  ADD COLUMN IF NOT EXISTS signature_image_url   TEXT,
  ADD COLUMN IF NOT EXISTS signed_ip             TEXT,
  ADD COLUMN IF NOT EXISTS accepted_terms_at     TIMESTAMPTZ;

-- Módulo 4: Análise de Crédito backoffice
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS is_risco_franqueado BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS risco_assumido_em   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arquivado_em        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arquivado_motivo    TEXT;

-- Ampliar CHECK de status em contratos para incluir 'arquivado'
ALTER TABLE contratos DROP CONSTRAINT IF EXISTS contratos_status_check;
ALTER TABLE contratos
  ADD CONSTRAINT contratos_status_check
  CHECK (status IN ('rascunho','enviado','em_analise','ativo','cancelado','arquivado'));
