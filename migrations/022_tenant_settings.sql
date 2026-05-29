-- Migration: 022_tenant_settings
-- Adiciona campos de configuração e integração na tabela de tenants

ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS logo_url TEXT,
ADD COLUMN IF NOT EXISTS asaas_api_key TEXT,
ADD COLUMN IF NOT EXISTS asaas_wallet_id TEXT,
ADD COLUMN IF NOT EXISTS tiktok_access_token TEXT,
ADD COLUMN IF NOT EXISTS tiktok_shop_id TEXT,
ADD COLUMN IF NOT EXISTS configuracoes_json JSONB DEFAULT '{}'::jsonb;

-- Segurança básica: chaves de API não devem ser vazadas facilmente
COMMENT ON COLUMN tenants.asaas_api_key IS 'Chave de API do Asaas para split de pagamentos/cobrança. Mantenha seguro.';
COMMENT ON COLUMN tenants.tiktok_access_token IS 'Token de acesso OAuth para integração com TikTok Shop da franquia.';
