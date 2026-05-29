CREATE TABLE IF NOT EXISTS leads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franqueadora_id  UUID NOT NULL REFERENCES tenants(id),
  nome             TEXT NOT NULL,
  nicho            TEXT,
  cidade           TEXT,
  estado           TEXT,
  lat              NUMERIC(10,7),
  lng              NUMERIC(10,7),
  fat_estimado     NUMERIC(15,2) DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'disponivel'
                     CHECK (status IN ('disponivel','pego','expirado')),
  pego_por         UUID REFERENCES tenants(id),
  pego_em          TIMESTAMPTZ,
  expira_em        TIMESTAMPTZ,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leads_status    ON leads(status);
CREATE INDEX idx_leads_pego_por  ON leads(pego_por);
