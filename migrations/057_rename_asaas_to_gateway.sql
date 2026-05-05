-- Substituição 100% Asaas → Appmax. Renomeia colunas asaas_* pra gateway_*
-- (genérico, suporta troca futura de provider sem mudar schema). Idempotente.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='asaas_api_key') THEN
    ALTER TABLE tenants RENAME COLUMN asaas_api_key TO gateway_api_key;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='asaas_wallet_id') THEN
    ALTER TABLE tenants RENAME COLUMN asaas_wallet_id TO gateway_wallet_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clientes' AND column_name='asaas_customer_id') THEN
    ALTER TABLE clientes RENAME COLUMN asaas_customer_id TO gateway_customer_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='boletos' AND column_name='asaas_id') THEN
    ALTER TABLE boletos RENAME COLUMN asaas_id TO gateway_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='boletos' AND column_name='asaas_url') THEN
    ALTER TABLE boletos RENAME COLUMN asaas_url TO gateway_url;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='boletos' AND column_name='asaas_pix_copia_cola') THEN
    ALTER TABLE boletos RENAME COLUMN asaas_pix_copia_cola TO gateway_pix_copia_cola;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='boletos' AND column_name='asaas_error') THEN
    ALTER TABLE boletos RENAME COLUMN asaas_error TO gateway_error;
  END IF;
END $$;

ALTER TABLE boletos ADD COLUMN IF NOT EXISTS gateway_provider VARCHAR(20) DEFAULT 'appmax';
