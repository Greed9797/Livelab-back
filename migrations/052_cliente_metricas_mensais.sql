-- Snapshot agregado mensal por cliente: persiste histórico imutável após
-- fechamento do mês pra consultas rápidas e comparações ano-a-ano.
CREATE TABLE IF NOT EXISTS cliente_metricas_mensais (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id             UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ano                    INT NOT NULL,
  mes                    INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  gmv_total              NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_pedidos          INT           NOT NULL DEFAULT 0,
  itens_vendidos         INT           NOT NULL DEFAULT 0,
  ticket_medio           NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_lives            INT           NOT NULL DEFAULT 0,
  horas_live             NUMERIC(10,2) NOT NULL DEFAULT 0,
  viewers_total          BIGINT        NOT NULL DEFAULT 0,
  comentarios_total      BIGINT        NOT NULL DEFAULT 0,
  likes_total            BIGINT        NOT NULL DEFAULT 0,
  shares_total           BIGINT        NOT NULL DEFAULT 0,
  valor_investido_lives  NUMERIC(15,2) NOT NULL DEFAULT 0,
  roas                   NUMERIC(10,4) NOT NULL DEFAULT 0,
  fechado_em             TIMESTAMPTZ,
  atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cliente_id, ano, mes)
);

CREATE INDEX IF NOT EXISTS idx_cmm_tenant_ano_mes ON cliente_metricas_mensais (tenant_id, ano DESC, mes DESC);
CREATE INDEX IF NOT EXISTS idx_cmm_cliente_ano_mes ON cliente_metricas_mensais (cliente_id, ano DESC, mes DESC);

ALTER TABLE cliente_metricas_mensais ENABLE ROW LEVEL SECURITY;

CREATE POLICY cmm_tenant ON cliente_metricas_mensais
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
