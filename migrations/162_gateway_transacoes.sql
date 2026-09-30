-- Migration 162: Asaas SOMENTE LEITURA — cache do extrato + vínculo de conciliação.
-- Colunas reaproveitadas (migrations 019/022 → renomeadas na 057):
--   tenants.gateway_api_key (chave Asaas, hoje em texto claro via /v1/configuracoes)
--   clientes.gateway_customer_id (cus_* do Asaas)
-- O ADD COLUMN IF NOT EXISTS abaixo é só salvaguarda para bancos que não tenham as colunas.
-- O vínculo conciliado_com_* é polimórfico (receita_titulos | custos) e sem FK:
-- receita_titulos nasce na 165 e custos é reformulada na 164; a rota valida o alvo.
-- NÃO emite cobrança nem escreve nada no Asaas. Idempotente.

ALTER TABLE tenants  ADD COLUMN IF NOT EXISTS gateway_api_key TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS gateway_customer_id TEXT;

CREATE TABLE IF NOT EXISTS gateway_transacoes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider             VARCHAR(20) NOT NULL DEFAULT 'asaas',
  asaas_id             TEXT NOT NULL,
  tipo                 TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  tipo_asaas           TEXT,
  valor                NUMERIC(15,2) NOT NULL CHECK (valor >= 0),
  valor_bruto          NUMERIC(15,2),
  data                 DATE NOT NULL,
  descricao            TEXT,
  customer_id          TEXT,
  payment_id           TEXT,
  cliente_id           UUID REFERENCES clientes(id) ON DELETE SET NULL,
  raw                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  conciliado_com_tipo  TEXT CHECK (conciliado_com_tipo IN ('receita', 'custo')),
  conciliado_com_id    UUID,
  conciliado_em        TIMESTAMPTZ,
  conciliado_por       UUID REFERENCES users(id) ON DELETE SET NULL,
  sincronizado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_gateway_transacoes_tenant_asaas UNIQUE (tenant_id, asaas_id),
  CONSTRAINT chk_gateway_transacoes_conciliacao
    CHECK ((conciliado_com_tipo IS NULL) = (conciliado_com_id IS NULL))
);

COMMENT ON TABLE gateway_transacoes IS
  'Cache somente-leitura do extrato Asaas por tenant + vínculo de conciliação com receita_titulos/custos.';

CREATE INDEX IF NOT EXISTS idx_gateway_transacoes_tenant_data
  ON gateway_transacoes(tenant_id, data);
CREATE INDEX IF NOT EXISTS idx_gateway_transacoes_pendentes
  ON gateway_transacoes(tenant_id, tipo, data) WHERE conciliado_com_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_gateway_transacoes_customer
  ON gateway_transacoes(tenant_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gateway_transacoes_alvo
  ON gateway_transacoes(tenant_id, conciliado_com_tipo, conciliado_com_id) WHERE conciliado_com_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_gateway_customer
  ON clientes(tenant_id, gateway_customer_id) WHERE gateway_customer_id IS NOT NULL;

ALTER TABLE gateway_transacoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gateway_transacoes_tenant ON gateway_transacoes;
CREATE POLICY gateway_transacoes_tenant ON gateway_transacoes
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
