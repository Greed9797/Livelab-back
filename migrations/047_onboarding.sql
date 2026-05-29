-- Adiciona flag de onboarding na tabela users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false;

-- Tabela de respostas de onboarding (pós-login cliente_parceiro)
CREATE TABLE IF NOT EXISTS onboarding_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_name      TEXT NOT NULL,
  responsible_name  TEXT NOT NULL,
  main_products     TEXT NOT NULL,
  sales_history     TEXT NOT NULL,
  focus_products    TEXT NOT NULL,
  current_stock     TEXT NOT NULL,
  product_margin    TEXT NOT NULL,
  gmv_expectation   TEXT NOT NULL,
  traffic_budget    TEXT NOT NULL,
  website_url       TEXT,
  instagram_url     TEXT,
  tiktok_url        TEXT,
  tiktok_shop_url   TEXT,
  available_offers  TEXT,
  live_experience   TEXT NOT NULL CHECK (live_experience IN ('none','low','moderate','advanced')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_tenant ON onboarding_responses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_user   ON onboarding_responses(user_id);

ALTER TABLE onboarding_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY onboarding_tenant ON onboarding_responses
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
