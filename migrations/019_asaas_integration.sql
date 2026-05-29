-- migrations/019_asaas_integration.sql

-- ============================================================
-- 1. Enhance boletos table com campos do Asaas
-- ============================================================
ALTER TABLE boletos
  ADD COLUMN IF NOT EXISTS asaas_id          TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS asaas_url         TEXT,
  ADD COLUMN IF NOT EXISTS asaas_pix_copia_cola TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS live_id           UUID REFERENCES lives(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gerado_automaticamente BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS asaas_error       TEXT;

-- Preencher idempotency_key em registros existentes (retroativo)
UPDATE boletos
  SET idempotency_key = gen_random_uuid()::text
  WHERE idempotency_key IS NULL;

ALTER TABLE boletos
  ALTER COLUMN idempotency_key SET NOT NULL;

-- ============================================================
-- 2. Adicionar asaas_customer_id em clientes (evita re-lookup)
-- ============================================================
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT;

-- ============================================================
-- 3. Tabela de log imutável de webhooks recebidos
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_eventos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id),
  source          TEXT NOT NULL DEFAULT 'asaas',
  event_type      TEXT,
  payload_raw     JSONB NOT NULL,
  boleto_id       UUID REFERENCES boletos(id),
  processado      BOOLEAN NOT NULL DEFAULT false,
  processado_em   TIMESTAMPTZ,
  error_log       TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Imutabilidade: proibir DELETE e UPDATE (auditoria)
CREATE OR REPLACE RULE no_delete_webhook_eventos
  AS ON DELETE TO webhook_eventos DO INSTEAD NOTHING;

CREATE OR REPLACE RULE no_update_webhook_eventos
  AS ON UPDATE TO webhook_eventos DO INSTEAD NOTHING;

-- ============================================================
-- 4. RLS para webhook_eventos
-- ============================================================
ALTER TABLE webhook_eventos ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_eventos_tenant_isolation
  ON webhook_eventos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
