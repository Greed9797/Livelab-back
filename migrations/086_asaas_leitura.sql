-- Migration 086: Asaas SOMENTE LEITURA + conciliação (frente B do financeiro)
-- Objetivo:
--   1. Cache local das movimentações do extrato Asaas (GET /financialTransactions),
--      enriquecidas com a cobrança (GET /payments) quando houver paymentId.
--   2. Campos de conciliação polimórfica: a transação aponta para uma
--      receita prevista (receitas_previstas, migration 087) ou um custo (custos).
--      Sem FK em conciliado_com_id porque o alvo depende de conciliado_com_tipo
--      e receitas_previstas só nasce na 087 — a validação é feita na rota.
--
-- Reaproveita colunas existentes (ver 057): tenants.gateway_api_key (chave Asaas
-- do tenant) e clientes.gateway_customer_id (id cus_* do Asaas).
-- NÃO emite cobrança nem escreve nada no Asaas.
--
-- Idempotente: CREATE ... IF NOT EXISTS + DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS gateway_transacoes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider             VARCHAR(20) NOT NULL DEFAULT 'asaas',
  asaas_id             TEXT NOT NULL,                 -- id da financialTransaction (ft_*)
  tipo                 TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  tipo_asaas           TEXT,                          -- ex.: PAYMENT_RECEIVED, PAYMENT_FEE, TRANSFER
  valor                NUMERIC(15,2) NOT NULL CHECK (valor >= 0), -- sempre positivo; sentido em `tipo`
  valor_bruto          NUMERIC(15,2),                 -- payment.value (antes de taxas), quando houver
  data                 DATE NOT NULL,
  descricao            TEXT,
  customer_id          TEXT,                          -- cus_* do Asaas (via payment)
  payment_id           TEXT,                          -- pay_* do Asaas
  cliente_id           UUID REFERENCES clientes(id) ON DELETE SET NULL, -- resolvido por gateway_customer_id
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
  'Cache somente-leitura do extrato Asaas por tenant + vínculo de conciliação com receitas_previstas/custos.';

CREATE INDEX IF NOT EXISTS idx_gateway_transacoes_tenant_data
  ON gateway_transacoes(tenant_id, data);

CREATE INDEX IF NOT EXISTS idx_gateway_transacoes_pendentes
  ON gateway_transacoes(tenant_id, tipo, data)
  WHERE conciliado_com_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_gateway_transacoes_customer
  ON gateway_transacoes(tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gateway_transacoes_alvo
  ON gateway_transacoes(tenant_id, conciliado_com_tipo, conciliado_com_id)
  WHERE conciliado_com_id IS NOT NULL;

-- Lookup de cliente pelo customer do Asaas durante a sincronização
CREATE INDEX IF NOT EXISTS idx_clientes_gateway_customer
  ON clientes(tenant_id, gateway_customer_id)
  WHERE gateway_customer_id IS NOT NULL;

ALTER TABLE gateway_transacoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gateway_transacoes_tenant ON gateway_transacoes;
CREATE POLICY gateway_transacoes_tenant ON gateway_transacoes
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
