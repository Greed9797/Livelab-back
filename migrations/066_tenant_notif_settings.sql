-- F1: configurações de notificação por tenant.
-- Cada flag controla um tipo de e-mail. notif_email_ativo é o master switch.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notif_email_ativo     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notif_live_meta       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notif_boleto_vencido  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notif_lead_novo       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notif_contrato        BOOLEAN NOT NULL DEFAULT true;
