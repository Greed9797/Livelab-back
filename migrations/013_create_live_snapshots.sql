-- Migration 013: Snapshots das lives (dados TikTok capturados a cada 60s)
CREATE TABLE live_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id        UUID NOT NULL REFERENCES lives(id),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  viewer_count   INTEGER DEFAULT 0,
  total_viewers  INTEGER DEFAULT 0,
  total_orders   INTEGER DEFAULT 0,
  gmv            NUMERIC(15,2) DEFAULT 0,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para otimizar as buscas por live, tenant e tempo (usados nas queries do histórico)
CREATE INDEX idx_snapshots_live   ON live_snapshots(live_id);
CREATE INDEX idx_snapshots_tenant ON live_snapshots(tenant_id);
CREATE INDEX idx_snapshots_time   ON live_snapshots(captured_at);

-- Habilitando RLS (Row Level Security) para garantir o isolamento por tenant
ALTER TABLE live_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY snapshots_rls ON live_snapshots
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
