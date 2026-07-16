-- Migration 123: índice para as agregações do CRM.
--
-- GET /v1/crm/summary filtra por (franqueadora_id, crm_etapa) 4 vezes por request.
-- Existia só idx_leads_franqueadora_id (coluna única) e idx_leads_crm_etapa é
-- (pego_por, crm_etapa) — prefixo errado, inútil para este filtro.

CREATE INDEX IF NOT EXISTS idx_leads_franqueadora_crm_etapa
  ON leads (franqueadora_id, crm_etapa);
