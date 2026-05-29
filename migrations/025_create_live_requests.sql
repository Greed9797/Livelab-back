-- Migration 025: tabela de solicitações de live por cliente_parceiro
-- Timezone-safe: data_solicitada é DATE, hora_inicio/hora_fim são TIME (sem fuso)

CREATE TABLE IF NOT EXISTS live_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  cabine_id       UUID NOT NULL REFERENCES cabines(id),
  cliente_id      UUID NOT NULL REFERENCES clientes(id),
  solicitante_id  UUID NOT NULL REFERENCES users(id),
  data_solicitada DATE NOT NULL,
  hora_inicio     TIME NOT NULL,
  hora_fim        TIME NOT NULL,
  observacao      TEXT,
  status          TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'aprovada', 'recusada')),
  motivo_recusa   TEXT,
  aprovado_por    UUID REFERENCES users(id),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT hora_fim_depois_inicio CHECK (hora_fim > hora_inicio)
);

ALTER TABLE live_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY live_requests_tenant ON live_requests
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Índice para validação de overlap na aprovação
CREATE INDEX IF NOT EXISTS idx_live_requests_overlap
  ON live_requests (tenant_id, cabine_id, data_solicitada)
  WHERE status = 'aprovada';

-- Índice para listagem do cliente (solicitações por cabine)
CREATE INDEX IF NOT EXISTS idx_live_requests_cliente
  ON live_requests (tenant_id, cliente_id, criado_em DESC);

-- Índice para listagem do franqueador (por status + data)
CREATE INDEX IF NOT EXISTS idx_live_requests_status
  ON live_requests (tenant_id, status, data_solicitada);
